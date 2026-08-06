/**
 * @responsibility Attributes cycle failures to their root classes from the event stream.
 */
import type { FailureClass } from "@roll/spec";
import { blockCauseRootKey, parseEventLine, type RollEvent } from "@roll/spec";
import { EventBus } from "@roll/core";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type { FailureClass };

export interface FailureAttributionInput {
  readonly stage:
    | "pre-spawn"
    | "active-spawn"
    | "post-spawn"
    | "post-cycle"
    | "preflight"
    | "capture"
    | "worktree"
    | "auth"
    | "network"
    | "agent-spawn"
    | "build"
    | "score"
    | "attest"
    | "publish"
    | "rescue"
    | "terminal";
  readonly source: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly sawAgentOutput?: boolean;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly tcrCount?: number;
  /** True iff the agent timed out with zero output — vendor stall (FIX-1213). */
  readonly agentTimedOut?: boolean;
}

export interface FailureAttribution {
  readonly failureClass: FailureClass;
  readonly rootCauseKey: string;
  readonly confidence: "envelope" | "corroborated" | "unknown";
}

export interface CycleFailureAttributionInput {
  readonly cycleId: string;
  readonly terminal: string | undefined;
  readonly tcrCount?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly agentExecuted?: boolean;
  readonly mainDirty?: boolean;
  readonly agentInternalFailure?: boolean;
  readonly agentTimedOut?: boolean;
  readonly events?: readonly RollEvent[];
}

interface RootCauseState {
  readonly causes: Record<string, { timestamps: readonly number[]; lastCycleId: string; failureClass: FailureClass }>;
}

export interface RootCauseFailureResult {
  readonly count: number;
  readonly paused: boolean;
  readonly rootCauseKey: string;
  readonly snapshotPath?: string;
}

export const DEFAULT_ROOT_CAUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_FALLBACK_SOURCE = "fallback:no_evidence";

const ENV_STAGE_ROOT: Partial<Record<FailureAttributionInput["stage"], string>> = {
  "pre-spawn": "env:pre_spawn",
  "active-spawn": "env:sandbox",
  "post-spawn": "env:sandbox",
  "post-cycle": "env:sandbox",
  preflight: "env:preflight",
  capture: "env:sandbox",
  worktree: "env:worktree",
  auth: "env:auth",
  network: "env:network",
};

const HARNESS_STAGE_ROOT: Partial<Record<FailureAttributionInput["stage"], string>> = {
  score: "harness:score_parse",
  attest: "harness:attest_render",
  publish: "harness:publish",
  rescue: "harness:rescue",
};

function normalizedSource(input: string): string {
  return input.trim().toLowerCase();
}

function hasUsage(input: FailureAttributionInput): boolean {
  return (input.tokensIn ?? 0) > 0 || (input.tokensOut ?? 0) > 0;
}

interface SourceRootRule {
  readonly match: "exact" | "prefix";
  readonly source: string;
  readonly failureClass: "env" | "harness";
  readonly rootCauseKey: string;
}

const SOURCE_ROOT_RULES: readonly SourceRootRule[] = [
  // Sandbox events/flags emitted by classifyCycleFailure for main checkout guards.
  { match: "exact", source: "sandbox:main_dirty", failureClass: "env", rootCauseKey: "env:main_dirty" },
  { match: "exact", source: "sandbox:quarantined", failureClass: "env", rootCauseKey: "env:sandbox" },
  { match: "exact", source: "sandbox:write_protected", failureClass: "env", rootCauseKey: "env:sandbox" },
  // Agent block envelopes emitted from agent:blocked events.
  { match: "exact", source: "agent:auth", failureClass: "env", rootCauseKey: "env:auth" },
  { match: "exact", source: "agent:network", failureClass: "env", rootCauseKey: "env:network" },
  // Legacy direct source labels accepted before stage fallback existed.
  { match: "exact", source: "worktree", failureClass: "env", rootCauseKey: "env:worktree" },
  { match: "prefix", source: "worktree:", failureClass: "env", rootCauseKey: "env:worktree" },
  { match: "exact", source: "auth", failureClass: "env", rootCauseKey: "env:auth" },
  { match: "prefix", source: "auth:", failureClass: "env", rootCauseKey: "env:auth" },
  { match: "exact", source: "credential", failureClass: "env", rootCauseKey: "env:auth" },
  { match: "prefix", source: "credential:", failureClass: "env", rootCauseKey: "env:auth" },
  { match: "exact", source: "network", failureClass: "env", rootCauseKey: "env:network" },
  { match: "prefix", source: "network:", failureClass: "env", rootCauseKey: "env:network" },
  { match: "exact", source: "vendor", failureClass: "env", rootCauseKey: "env:network" },
  { match: "prefix", source: "vendor:", failureClass: "env", rootCauseKey: "env:network" },
  { match: "exact", source: "provider", failureClass: "env", rootCauseKey: "env:network" },
  { match: "prefix", source: "provider:", failureClass: "env", rootCauseKey: "env:network" },
  // Harness events emitted by scoring, attest, publish, rescue, and component guards.
  { match: "exact", source: "pair:score-failure", failureClass: "harness", rootCauseKey: "harness:score_parse" },
  { match: "exact", source: "attest", failureClass: "harness", rootCauseKey: "harness:attest_render" },
  { match: "prefix", source: "attest:", failureClass: "harness", rootCauseKey: "harness:attest_render" },
  { match: "exact", source: "publish", failureClass: "harness", rootCauseKey: "harness:publish" },
  { match: "prefix", source: "publish:", failureClass: "harness", rootCauseKey: "harness:publish" },
  { match: "prefix", source: "pr:", failureClass: "harness", rootCauseKey: "harness:publish" },
  { match: "prefix", source: "gh ", failureClass: "harness", rootCauseKey: "harness:publish" },
  { match: "exact", source: "cycle:rescue", failureClass: "harness", rootCauseKey: "harness:rescue" },
  { match: "prefix", source: "roll-component:", failureClass: "harness", rootCauseKey: "harness:component" },
  { match: "prefix", source: "harness-component:", failureClass: "harness", rootCauseKey: "harness:component" },
];

function rootForKnownSource(source: string): Pick<FailureAttribution, "failureClass" | "rootCauseKey"> | null {
  const rule = SOURCE_ROOT_RULES.find((candidate) => (candidate.match === "exact" ? source === candidate.source : source.startsWith(candidate.source)));
  return rule === undefined ? null : { failureClass: rule.failureClass, rootCauseKey: rule.rootCauseKey };
}

function isAgentCliSpawnFailure(input: FailureAttributionInput, source: string): boolean {
  if (input.stage !== "agent-spawn") return false;
  if (input.exitCode === undefined || input.exitCode === 0) return false;
  if (input.sawAgentOutput === true) return false;
  const stderr = normalizedSource(input.stderr ?? "");
  return (
    source === "agent-cli" ||
    source.startsWith("agent-cli:") ||
    stderr.includes("command not found") ||
    stderr.includes("no such file") ||
    stderr.includes("permission denied") ||
    stderr.includes("spawn")
  );
}

export function classifyFailure(input: FailureAttributionInput): FailureAttribution {
  const source = normalizedSource(input.source);
  const sourceRoot = rootForKnownSource(source);
  if (sourceRoot !== null) return { ...sourceRoot, confidence: "envelope" };

  const envStageRoot = ENV_STAGE_ROOT[input.stage];
  if (envStageRoot !== undefined) {
    return { failureClass: "env", rootCauseKey: envStageRoot, confidence: hasUsage(input) ? "corroborated" : "envelope" };
  }

  if (isAgentCliSpawnFailure(input, source)) {
    return { failureClass: "env", rootCauseKey: "env:agent_cli_spawn", confidence: "envelope" };
  }

  const harnessStageRoot = HARNESS_STAGE_ROOT[input.stage];
  if (harnessStageRoot !== undefined) {
    return { failureClass: "harness", rootCauseKey: harnessStageRoot, confidence: "envelope" };
  }

  if (input.stage === "build" && (hasUsage(input) || (input.tcrCount ?? 0) > 0)) {
    // FIX-1213: zero-output timeout is env:agent_stall, not card.
    const buildOutputZero = (input.tcrCount ?? 0) === 0 && (input.tokensOut ?? 0) === 0;
    if (buildOutputZero && input.agentTimedOut === true) {
      return { failureClass: "env", rootCauseKey: "env:agent_stall", confidence: "corroborated" };
    }
    return { failureClass: "card", rootCauseKey: "card:agent_after_build", confidence: "corroborated" };
  }

  return { failureClass: "unknown", rootCauseKey: "unknown:unclassified", confidence: "unknown" };
}

function sameCycle(cycleId: string): (event: RollEvent) => boolean {
  return (event) => {
    const rec = event as unknown as Record<string, unknown>;
    return rec["cycleId"] === cycleId;
  };
}

export function readCycleEvents(eventsPath: string, cycleId: string): RollEvent[] {
  try {
    if (!existsSync(eventsPath)) return [];
    return readFileSync(eventsPath, "utf8")
      .split("\n")
      .map(parseEventLine)
      .filter((event): event is RollEvent => event !== null)
      .filter(sameCycle(cycleId));
  } catch {
    return [];
  }
}

export function classifyCycleFailure(input: CycleFailureAttributionInput): FailureAttribution {
  const events = input.events ?? [];
  const hasAgentWorkEvidence = (input.tcrCount ?? 0) > 0 || (input.tokensIn ?? 0) > 0 || (input.tokensOut ?? 0) > 0;
  const recorded = events.find((event) => {
    const rec = event as unknown as Record<string, unknown>;
    return event.type === "cycle:end" && typeof rec["failure_class"] === "string";
  });
  const recordedAttribution = (): FailureAttribution | null => {
    if (recorded === undefined) return null;
    const rec = recorded as unknown as Record<string, unknown>;
    const cls = rec["failure_class"];
    const root = rec["root_cause_key"];
    if ((cls === "env" || cls === "harness" || cls === "card" || cls === "unknown") && typeof root === "string") {
      return { failureClass: cls, rootCauseKey: root, confidence: cls === "unknown" ? "unknown" : "envelope" };
    }
    return null;
  };
  const hasReplayEvidence = hasAgentWorkEvidence || events.some((event) => event.type !== "cycle:end");
  if (events.some((event) => event.type === "builder:boundary_violation")) {
    return { failureClass: "env", rootCauseKey: "env:main_dirty", confidence: "envelope" };
  }
  const sandboxDirty = events.find((event) => event.type === "sandbox:main_dirty");
  if (sandboxDirty !== undefined && !hasAgentWorkEvidence) {
    return classifyFailure({ stage: sandboxDirty.phase, source: "sandbox:main_dirty", tcrCount: input.tcrCount });
  }
  const sandboxQuarantine = events.find((event) => event.type === "sandbox:quarantined");
  if (sandboxQuarantine !== undefined && !hasAgentWorkEvidence) {
    return classifyFailure({ stage: sandboxQuarantine.phase, source: "sandbox:quarantined", tcrCount: input.tcrCount });
  }
  const blocked = events.find((event) => event.type === "agent:blocked");
  if (blocked !== undefined) {
    // REFACTOR-067: use shared spec taxonomy instead of indirect stage→rules path.
    return { failureClass: "env", rootCauseKey: blockCauseRootKey(blocked.cause), confidence: "envelope" };
  }
  if (events.some((event) => event.type === "pair:score-failure")) {
    return classifyFailure({ stage: "score", source: "pair:score-failure", tcrCount: input.tcrCount });
  }
  if (events.some((event) => event.type === "cycle:rescue")) {
    return classifyFailure({ stage: "rescue", source: "cycle:rescue", tcrCount: input.tcrCount });
  }
  if (input.agentInternalFailure === true) {
    return classifyFailure({ stage: "build", source: "harness-component:agent_internal", tcrCount: input.tcrCount });
  }
  // FIX-1213: zero-output timed-out build is a vendor stall, not a card failure.
  // Agent consumed prompt tokens but produced NO output — the vendor is silent.
  const outputZero = (input.tcrCount ?? 0) === 0 && (input.tokensOut ?? 0) === 0;
  if (hasAgentWorkEvidence && outputZero && input.agentTimedOut === true) {
    return { failureClass: "env", rootCauseKey: "env:agent_stall", confidence: "corroborated" };
  }
  if (hasAgentWorkEvidence) {
    return classifyFailure({
      stage: "build",
      source: "agent",
      tcrCount: input.tcrCount,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      agentTimedOut: input.agentTimedOut,
    });
  }
  if (input.mainDirty === true) {
    return classifyFailure({ stage: "preflight", source: "sandbox:main_dirty", tcrCount: input.tcrCount });
  }
  if (!hasReplayEvidence) {
    const fallback = recordedAttribution();
    if (fallback !== null) return fallback;
  }
  if (input.terminal === "failed" || input.terminal === "blocked" || input.terminal === "gave_up") {
    return classifyFailure({ stage: "terminal", source: UNKNOWN_FALLBACK_SOURCE });
  }
  return classifyFailure({ stage: "terminal", source: UNKNOWN_FALLBACK_SOURCE });
}

function statePath(runtimeDir: string): string {
  return join(runtimeDir, "failure-attribution.json");
}

function diagnosticsDir(runtimeDir: string): string {
  return join(runtimeDir, "diagnostics");
}

function emitFailureAttributionAlert(runtimeDir: string, message: string, nowMs = Date.now()): void {
  try {
    mkdirSync(runtimeDir, { recursive: true });
    new EventBus().appendEvent(join(runtimeDir, "events.ndjson"), {
      type: "alert:notify",
      channel: "failure-attribution",
      message,
      ts: Math.floor(nowMs / 1000),
    });
  } catch {
    process.stderr.write(`roll failure-attribution alert failed: ${message}\n`);
  }
}

function readRootCauseState(runtimeDir: string): RootCauseState {
  const path = statePath(runtimeDir);
  try {
    if (!existsSync(path)) return { causes: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      emitFailureAttributionAlert(runtimeDir, "failure-attribution state reset: invalid state object");
      return { causes: {} };
    }
    const causesRaw = (parsed as Record<string, unknown>)["causes"];
    if (causesRaw === null || typeof causesRaw !== "object") {
      emitFailureAttributionAlert(runtimeDir, "failure-attribution state reset: invalid causes object");
      return { causes: {} };
    }

    const causes: RootCauseState["causes"] = {};
    for (const [key, value] of Object.entries(causesRaw as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const failureClass = rec["failureClass"];
      const lastCycleId = rec["lastCycleId"];
      const timestamps = rec["timestamps"];
      if (failureClass !== "env" && failureClass !== "harness" && failureClass !== "unknown") continue;
      if (typeof lastCycleId !== "string") continue;
      if (!Array.isArray(timestamps)) continue;
      const validTimestamps = timestamps.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts));
      causes[key] = { timestamps: validTimestamps, lastCycleId, failureClass };
    }
    return { causes };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitFailureAttributionAlert(runtimeDir, `failure-attribution state reset: ${reason}`);
    return { causes: {} };
  }
}

export function clearRootCauseFailure(runtimeDir: string, rootCauseKey: string): void {
  const state = readRootCauseState(runtimeDir);
  if (state.causes[rootCauseKey] === undefined) return;
  const nextCauses = { ...state.causes };
  delete nextCauses[rootCauseKey];
  writeRootCauseState(runtimeDir, { causes: nextCauses });
}

function writeRootCauseState(runtimeDir: string, state: RootCauseState): void {
  const path = statePath(runtimeDir);
  const tmp = join(runtimeDir, `.failure-attribution.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitFailureAttributionAlert(runtimeDir, `failure-attribution state write failed: ${reason}`);
  }
}

/** REFACTOR-068: unified correction→failure attribution — correction signals
 *  map through the single failure taxonomy instead of carrying independent
 *  failureClass/rootCauseKey. */
export function classifyCorrectionFailure(signal: string): Pick<FailureAttribution, "failureClass" | "rootCauseKey"> {
  const normalizedSignal = signal.trim().toLowerCase().replace(/[-\s]+/g, "_");
  switch (normalizedSignal) {
    case "review_score_regression":
      return { failureClass: "card", rootCauseKey: "card:review_score_regression" };
    case "empty_acceptance_report":
      return { failureClass: "card", rootCauseKey: "card:empty_acceptance" };
    case "missing_acceptance_report":
      return { failureClass: "card", rootCauseKey: "card:missing_acceptance" };
    case "ci_failed":
      return { failureClass: "harness", rootCauseKey: "harness:ci_red" };
    // FIX-1261: deterministic failure envelope — card-level signals with event evidence.
    case "card:deliverable_cmd_denied":
      return { failureClass: "card", rootCauseKey: "card:deliverable_cmd_denied" };
    case "card:ac_evidence_unmergeable":
      return { failureClass: "card", rootCauseKey: "card:ac_evidence_unmergeable" };
    case "card:surface_not_captured":
      return { failureClass: "card", rootCauseKey: "card:surface_not_captured" };
    default:
      return { failureClass: "unknown", rootCauseKey: "unknown:unclassified" };
  }
}

export function playbookForFailure(failureClass: FailureClass, rootCauseKey: string): string {
  if (failureClass === "env") {
    if (rootCauseKey === "env:main_dirty") {
      return "Environment repair: inspect the shared main checkout, preserve/quarantine leaked files, restore it to origin/main, then run roll loop resume.";
    }
    if (rootCauseKey.startsWith("env:quota")) return "Environment repair: wait for quota/credits to recover or switch the configured rig; the card should not be split.";
    if (rootCauseKey.startsWith("env:auth")) return "Environment repair: refresh agent credentials or provider login, then run roll loop resume.";
    if (rootCauseKey.startsWith("env:network")) return "Environment repair: restore network/VPN/proxy or provider reachability; the card should not be split.";
    return "Environment repair: fix the harness runtime or worktree environment, then resume dispatch.";
  }
  if (failureClass === "harness") {
    return "Harness repair: inspect the named Roll component, open a focused FIX if needed, then resume dispatch after the component is healthy.";
  }
  if (failureClass === "card") {
    return "Card repair: this was a real card attempt; investigate the story, split it, or change agent only after reviewing evidence.";
  }
  return "Unknown failure: add a deterministic failure envelope before charging any card.";
}

function writeDiagnosticSnapshot(
  runtimeDir: string,
  cycleId: string,
  attribution: FailureAttribution,
  events: readonly RollEvent[],
): string | undefined {
  try {
    const dir = diagnosticsDir(runtimeDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${attribution.rootCauseKey.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`);
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          cycleId,
          failureClass: attribution.failureClass,
          rootCauseKey: attribution.rootCauseKey,
          playbook: playbookForFailure(attribution.failureClass, attribution.rootCauseKey),
          recentEvents: events.slice(-20),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return file;
  } catch {
    return undefined;
  }
}

export function recordRootCauseFailure(
  runtimeDir: string,
  cycleId: string,
  attribution: FailureAttribution,
  events: readonly RollEvent[],
  threshold = 3,
  options: { readonly nowMs?: number; readonly windowMs?: number } = {},
): RootCauseFailureResult {
  if (attribution.failureClass === "card") {
    return { count: 0, paused: false, rootCauseKey: attribution.rootCauseKey };
  }
  const state = readRootCauseState(runtimeDir);
  const prior = state.causes[attribution.rootCauseKey];
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_ROOT_CAUSE_WINDOW_MS;
  const cutoffMs = nowMs - windowMs;
  const timestamps = [...(prior?.timestamps ?? []).filter((ts) => ts >= cutoffMs), nowMs];
  state.causes[attribution.rootCauseKey] = { timestamps, lastCycleId: cycleId, failureClass: attribution.failureClass };
  writeRootCauseState(runtimeDir, { causes: state.causes });
  const count = timestamps.length;
  const paused = count >= threshold;
  const snapshotPath = paused ? writeDiagnosticSnapshot(runtimeDir, cycleId, attribution, events) : undefined;
  return { count, paused, rootCauseKey: attribution.rootCauseKey, ...(snapshotPath !== undefined ? { snapshotPath } : {}) };
}
