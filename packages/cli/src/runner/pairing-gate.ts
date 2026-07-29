/**
 * US-PAIR-003 — Cross-Agent Pairing runtime gate (MVP walking skeleton).
 *
 * After a code-stage delivery, a heterogeneous peer (chosen by the US-PAIR-001
 * rational selector) ONE-WAY reviews the diff (A produces → B checks; no tmux
 * back-and-forth — peer/kimi/codex review of EVID-010 & PAIR-001 proved a single
 * pass already catches real bugs). The verdict lands as evidence (reusing the
 * peer-gate contract `<rt>/peer/cycle-<id>.pair.json`) + `pair:*` events.
 *
 * Hard invariants (pi pair-review): pairing NEVER fails or stalls a cycle —
 *   - 30s hard timeout on the peer review (deps.reviewPeer returns null on
 *     timeout/error), then we move on;
 *   - any throw is swallowed (status "error");
 *   - the cost is recorded in pair:verdict from day one, so the budget gate is
 *     never blind to pairing spend even before US-PAIR-005.
 * The peer spawn is an injected seam (deps.reviewPeer) so this is unit-tested
 * without launching real agents; the executor wires the real agentSpawn in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentIsKnown,
  AGENT_REGISTRY_NAMES,
  canonicalAgentName,
  isHeterogeneous,
  normalizeAgentScopeConfig,
  pairingConfigFromAgentScopeConfig,
  parseResizeSignal,
  selectPairingCandidates,
  type PairingConfig,
  type PairingHistory,
  type PairingStage,
  type ResizeSignal,
} from "@roll/core";
import type { AgentScopeConfig } from "@roll/spec";
import { writeReviewScoreNote } from "../lib/review-score.js";
import { scopedAgentPolicyPath } from "./agent-routing.js";
import { assessComplexity } from "./peer-gate.js";

type PairingConfigSource = "scoped-agents" | "default-score";
type LoadedPairingConfig = { cfg: PairingConfig; source: PairingConfigSource } | null;

function readScopedAgentLayer(path: string): { config: AgentScopeConfig; path: string } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.includes("roll-agents/v1")) return null;
  const parsed = normalizeAgentScopeConfig(text);
  if (parsed.config === null || parsed.errors.length > 0) {
    throw new Error(`invalid roll-agents/v1 config: ${parsed.errors.join("; ")}`);
  }
  return { config: parsed.config, path };
}

function loadScopedPairingConfig(projectDir: string, installed: readonly string[]): LoadedPairingConfig {
  const rollHome = process.env["ROLL_HOME"] ?? join(homedir(), ".roll");
  const layers = [
    readScopedAgentLayer(join(rollHome, "agents.yaml")),
    readScopedAgentLayer(scopedAgentPolicyPath(projectDir)),
  ].filter((layer): layer is { config: AgentScopeConfig; path: string } => layer !== null);
  if (layers.length === 0) return null;
  const scoped = layers.length === 1 ? layers[0]?.config : mergeScopedPairingLayers(layers.map((layer) => layer.config));
  if (scoped === undefined) return null;
  const cfg = pairingConfigFromAgentScopeConfig(scoped, installed);
  return cfg === null ? null : { cfg, source: "scoped-agents" };
}

function mergeScopedPairingLayers(layers: readonly AgentScopeConfig[]): AgentScopeConfig | undefined {
  const [base, ...rest] = layers;
  if (base === undefined) return undefined;
  return rest.reduce<AgentScopeConfig>(
    (acc, layer) => ({
      ...acc,
      agents: { ...acc.agents, ...layer.agents },
      models: { ...acc.models, ...layer.models },
      roles: { ...acc.roles, ...layer.roles },
      defaults: {
        ...acc.defaults,
        ...Object.fromEntries(
          Object.entries(layer.defaults).map(([scope, value]) => [
            scope,
            { roles: { ...(acc.defaults[scope]?.roles ?? {}), ...value.roles } },
          ]),
        ),
      },
    }),
    base,
  );
}

function loadPairingConfig(projectDir: string, installed: readonly string[], fallback?: PairingConfig): LoadedPairingConfig {
  const scoped = loadScopedPairingConfig(projectDir, installed);
  if (scoped !== null) return scoped;
  return fallback === undefined ? null : { cfg: fallback, source: "default-score" };
}

/**
 * US-PAIR-004 — the executor's stage-iteration seam. The scoped evaluate role
 * enables code pairing; absent scoped configuration means pairing is off.
 */
export function enabledPairingStages(projectDir: string): PairingStage[] {
  try {
    const loaded = loadPairingConfig(projectDir, AGENT_REGISTRY_NAMES);
    if (loaded === null) return [];
    const cfg = loaded.cfg;
    if (!cfg.enabled) return [];
    // De-dupe (kimi pair-review): a config that repeats a stage must not fire it
    // twice — duplicate peer spawns, duplicate events, and a clobbered evidence
    // file. Keep first-seen order so the config still reads top-to-bottom.
    // US-PAIR-009 (kimi pair-review): `score` is NOT a review stage — it fires
    // post-attest via runScorePairing with its own prompt/protocol. Routing it
    // through the generic review loop would double-spawn a peer and clobber
    // the score evidence file with a pair:verdict.
    return cfg.stages.filter((s, i, arr) => arr.indexOf(s) === i && s !== "score");
  } catch {
    return []; // invalid scoped config → pairing off, not a cycle failure
  }
}

/** Evidence path for a stage's verdict. `code` keeps the PAIR-003 legacy contract
 *  path (`cycle-<id>.pair.json`); other stages are namespaced so concurrent stages
 *  in one cycle never clobber each other. */
function evidencePath(runtimeDir: string, cycleId: string, stage: PairingStage): string {
  const dir = join(runtimeDir, "peer");
  const name = stage === "code" ? `cycle-${cycleId}.pair.json` : `cycle-${cycleId}.${stage}.pair.json`;
  return join(dir, name);
}

export interface PairReview {
  verdict: "agree" | "refine" | "object";
  findings: string[];
  cost: number;
}

export type PairEvent =
  | { type: "pair:selected"; cycleId: string; workingAgent: string; peer: string; stage: string; timeoutMs?: number; attempt?: number; reason?: string; ts: number }
  // FIX-1054 — the serial-dispatch policy events (see the events.ts contract).
  | { type: "pair:skipped"; cycleId: string; peers: string[]; reason: string; stage: string; ts: number }
  | { type: "pair:fanout"; cycleId: string; stage: string; reason: string; limit: number; peers: string[]; ts: number }
  | { type: "pair:verdict"; cycleId: string; peer: string; verdict: PairReview["verdict"]; findings: number; cost: number; stage: string; ts: number }
  | { type: "pair:score"; cycleId: string; peer: string; score: number; verdict: PairScore["verdict"]; cost: number; stage: "score" | "design"; ts: number }
  | { type: "pair:none-available"; cycleId: string; stage: string; reason: string; ts: number }
  /** FIX-910 — per-attempt score-stage failure attribution. Every null return
   *  from a scorer is now diagnosed (unparseable / timeout / auth-block /
   *  exit-error) and emitted so the loop can observe WHY a pool failed;
   *  no more silently swallowed nulls. */
  | { type: "pair:score-failure"; cycleId: string; peer: string; cause: "unparseable" | "timeout" | "auth-block" | "exit-error"; detail?: string; artifactPath?: string; stage: "score" | "design"; ts: number };

export interface RunPairingDeps {
  /** Installed agents (canonical), e.g. agentsInstalled(realAgentEnv()). */
  installed: string[];
  /** Liveness probe over CANONICAL agent names. */
  isAvailable: (agent: string) => boolean;
  /** One-way review: the peer reads the diff and returns a structured verdict,
   *  or null on timeout/error. The 30s hard timeout lives in the implementation. */
  reviewPeer: (peer: string, diff: string, timeoutMs: number) => Promise<PairReview | null>;
  /** Changed files of the cycle (defaults to peer-gate's cycleChangedFiles). */
  changedFiles: (worktreeCwd: string) => Promise<string[]>;
  /** Full cycle diff the peer reviews. */
  diff: (worktreeCwd: string) => Promise<string>;
  event: (e: PairEvent) => void;
  now: () => number;
  /** Override the 30s default (tests). */
  timeoutMs?: number;
  /**
   * US-PAIR-006 (optional): per-peer pairing track record from
   * {@link pairingHistory}. Drives the ε-greedy hit-rate preference in the
   * selector. Absent → pure seeded round-robin (US-PAIR-001 behaviour).
   */
  history?: PairingHistory;
  /** ε for the ε-greedy rotation (default 0.2). */
  epsilon?: number;
  /**
   * FIX-935: project-config allowed agents (from `.roll/agents.yaml` slots).
   * When supplied, candidates are restricted to this set.
   */
  allowedAgents?: Set<string> | readonly string[];
  /**
   * FIX-1054: opt into an explicit, bounded high-risk FAN-OUT (parallel take-first)
   * instead of the serial default. Present only when the caller has a real reason
   * (truth/release/evidence gate, security card, repeated prior failures, owner
   * quorum); absent → the cost-aware serial policy. The reason is recorded on a
   * `pair:fanout` event so fan-out is never a silent default.
   */
  fanout?: PairFanoutReason;
}

export interface RunPairingResult {
  status: "off" | "not-required" | "none-available" | "reviewed" | "timeout" | "error";
  peer?: string;
  verdict?: PairReview["verdict"];
}

// FIX-363: the review timeout is now data-tuned (the comment's "tuned from data,
// not guessed" promise, kept). The `pair:consult` history shows successful hetero
// reviews tail out to ~116s while ALL 55 timeouts landed EXACTLY at the 120s cap —
// i.e. 120s was CLIPPING the duration distribution, not catching genuine hangs. A
// 14-file/60K-char cross-module diff (FIX-356b) timed out all three reviewers at
// ~120004ms twice, blocking a delivery the builder had gotten right. So the budget
// scales with diff size, within the owner's ≤3min default / ≤5min complex policy:
//   • small/normal diff → 180s (3min) — the policy floor; was 120s, below policy.
//   • large/cross-module diff (≥20K chars) → 300s (5min) — the policy ceiling.
// Fail-loud is unchanged: a whole pool that still flakes within the (now adequate)
// budget BLOCKS — the gate is never weakened, reviewers are just given honest time.
const REVIEW_TIMEOUT_BASE_MS = 180_000;
const REVIEW_TIMEOUT_LARGE_MS = 300_000;
const REVIEW_LARGE_DIFF_CHARS = 20_000;

/**
 * FIX-363 — the peer-review wall-clock budget for a diff of `diffChars` length.
 * Two tiers (not three: the cycle diff is capped at 60K upstream, so finer
 * bucketing buys nothing): normal diffs get the 3min policy floor, large/
 * cross-module diffs (≥20K chars) get the 5min policy ceiling. The SCORE stage
 * does NOT use this — it scores a tiny `--stat` summary, never the full diff,
 * so it keeps its own flat budget ({@link SCORE_TIMEOUT_MS}).
 */
export function reviewTimeoutMs(diffChars: number): number {
  return diffChars >= REVIEW_LARGE_DIFF_CHARS ? REVIEW_TIMEOUT_LARGE_MS : REVIEW_TIMEOUT_BASE_MS;
}

/**
 * FIX-335 AC3 — parallel take-first: resolve with the FIRST promise that yields
 * a non-null value, discarding the rest. Preserves the serial semantics exactly,
 * just concurrently:
 *   - the FIRST non-null result wins immediately (later results are dropped, so
 *     evidence/events are only written for the winner);
 *   - a single promise REJECTING is tolerated — it must not sink a sibling that
 *     is still about to win (a flaky peer ≠ the whole consult failing);
 *   - all settled with NO winner → resolve null  → caller maps to "timeout"/block
 *     (the serial "whole pool failed" path);
 *   - …UNLESS at least one rejected → RE-THROW → caller's outer try/catch maps to
 *     status "error", matching the legacy serial behaviour where a thrown
 *     reviewPeer/scorePeer short-circuited to "error" (a broken probe is a defect,
 *     not a benign timeout).
 *
 * Why not Promise.race: race resolves on the first SETTLE, so a fast null/throw
 * would beat a slower real verdict. We want the first VALID (non-null) result.
 */
async function firstValid<T>(promises: Promise<T | null>[]): Promise<T | null> {
  if (promises.length === 0) return null;
  return new Promise<T | null>((resolve, reject) => {
    let pending = promises.length;
    let settled = false;
    let lastError: unknown;
    let threw = false;
    const onNonResult = (): void => {
      pending -= 1;
      if (pending === 0 && !settled) {
        settled = true;
        // No winner anywhere: a thrown probe ⇒ "error" (re-throw), else a clean
        // all-null pool ⇒ "timeout" (resolve null).
        if (threw) reject(lastError);
        else resolve(null);
      }
    };
    for (const p of promises) {
      p.then(
        (value) => {
          if (settled) return;
          if (value !== null) {
            settled = true;
            resolve(value); // first valid wins; siblings are discarded
            return;
          }
          onNonResult();
        },
        (err) => {
          // a rejected probe never sinks a sibling that may still win — only the
          // wholly-failing pool surfaces the error.
          if (settled) return;
          threw = true;
          lastError = err;
          onNonResult();
        },
      );
    }
  });
}

// ── FIX-1054: cost-aware SERIAL dispatch policy ─────────────────────────────
//
// Pairing used to optimize for liveness: fire every ranked candidate at once
// (firstValid) and accept whoever parses first. Reliable, but cost scaled with
// pool size — an ordinary card burned kimi+pi+reasonix+claude when ONE reliable
// reviewer/evaluator was enough. The DEFAULT is now SERIAL and bounded: try one
// selected candidate, fall back to the next ONLY on a real failure, and once a
// result is accepted the remaining candidates are SKIPPED (never spawned). The
// old parallel path survives ONLY as an explicit, reasoned, bounded high-risk
// FAN-OUT (firstValid), so the liveness escape hatch is still there when a
// truth/release/evidence gate or a security card genuinely wants a quorum.

export type PairDispatchMode = "serial" | "fanout";

export type PairingDispatchMode = "serial-take-first" | "parallel-first-valid";
export type PairingFallbackPolicy = "none" | "same-type-when-primary-empty";

export interface PairingDispatchDeps {
  cycleId: string;
  workingAgent: string;
  stage: PairingStage;
  candidates: readonly string[];
  mode: PairingDispatchMode;
  fallbackPolicy: PairingFallbackPolicy;
  sameTypeFallback: { allowed: boolean; peer?: string };
  blockOnNoWinner: boolean;
  diff: string;
  timeoutMs: number;
  reviewPeer: (peer: string, diff: string, timeoutMs: number) => Promise<PairReview | null>;
  event: (e: PairEvent) => void;
  now: () => number;
  fanoutReason?: PairFanoutReason;
  fanoutLimit?: number;
}

export type PairingDispatchResult =
  | {
      status: "none-available" | "timeout";
      blocked: boolean;
      peer?: undefined;
      review?: undefined;
      sameTypeFallback: boolean;
      skipped: string[];
    }
  | {
      status: "reviewed";
      blocked: false;
      peer: string;
      review: PairReview;
      sameTypeFallback: boolean;
      skipped: string[];
    };

/** The reasons that justify an explicit high-risk fan-out. Anything else stays
 *  serial. The reason is recorded on the `pair:fanout` event so it is auditable. */
export type PairFanoutReason =
  | "high_risk_truth_or_release_gate"
  | "security_sensitive_card"
  | "repeated_prior_failures"
  | "owner_requested_quorum"
  // US-CYCLE-008 — the card's LINT-VALIDATED design-contract declared
  // `risk_tier: high` (auth / data-integrity / state-machine / shared-state
  // harness). The evaluation fans out into a parallel adversarial panel. This is
  // the ONLY tier-driven fan-out reason; it is derived from the spec, never from
  // a supervisor/flag/env override (anti-Goodhart, see evaluation-tier.ts).
  | "high_risk_tier_card";

/** FIX-1054 — the bounded fan-out cap: even an explicit high-risk fan-out never
 *  spawns the entire installed roster. */
export const PAIR_FANOUT_LIMIT = 3;

/**
 * FIX-1054 — SERIAL take-first: try each candidate ONE AT A TIME in ranked
 * order. `attempt(peer, index)` fires exactly one candidate (emitting its own
 * `pair:selected`) and returns the tagged value, or null on a real failure
 * (timeout / auth-block / exit-error / unparseable — all surfaced as null by the
 * injected seam). The FIRST non-null result wins and the untried candidates are
 * returned as `skipped` so the caller can emit a policy-visible `pair:skipped`.
 *
 * Semantics vs {@link firstValid} (the fan-out primitive):
 *   - a THROW is a broken probe (a defect, not a benign failure) → it propagates
 *     to the caller's outer try/catch → status "error", matching firstValid's
 *     terminal-round rule and the existing "broken reviewPeer → error" contract;
 *   - all-null → winner null (caller maps to timeout/block — the whole pool
 *     honestly failed, exactly as the parallel path did);
 *   - cost is bounded by ACTUAL need: a first-candidate success spawns ONE agent.
 */
async function serialFirstValid<T>(
  candidates: readonly string[],
  attempt: (peer: string, index: number) => Promise<{ peer: string; value: T } | null>,
): Promise<{ winner: { peer: string; value: T } | null; skipped: string[] }> {
  for (let i = 0; i < candidates.length; i++) {
    const res = await attempt(candidates[i] as string, i);
    if (res !== null) return { winner: res, skipped: candidates.slice(i + 1) };
  }
  return { winner: null, skipped: [] };
}

function pairingDispatchPool(deps: PairingDispatchDeps): { peers: string[]; sameTypeFallback: boolean } {
  const primary = deps.candidates.map((c) => c as string);
  if (primary.length > 0) return { peers: primary, sameTypeFallback: false };
  if (
    deps.fallbackPolicy === "same-type-when-primary-empty" &&
    deps.sameTypeFallback.allowed &&
    deps.sameTypeFallback.peer !== undefined &&
    deps.sameTypeFallback.peer.trim() !== ""
  ) {
    return { peers: [deps.sameTypeFallback.peer], sameTypeFallback: true };
  }
  return { peers: [], sameTypeFallback: false };
}

export async function pairingDispatch(deps: PairingDispatchDeps): Promise<PairingDispatchResult> {
  const poolInfo = pairingDispatchPool(deps);
  if (poolInfo.peers.length === 0) {
    return { status: "none-available", blocked: deps.blockOnNoWinner, sameTypeFallback: false, skipped: [] };
  }

  if (deps.mode === "parallel-first-valid") {
    const pool = poolInfo.peers.slice(0, deps.fanoutLimit ?? poolInfo.peers.length);
    const reason = deps.fanoutReason;
    if (reason !== undefined) {
      deps.event({ type: "pair:fanout", cycleId: deps.cycleId, stage: deps.stage, reason, limit: deps.fanoutLimit ?? pool.length, peers: pool, ts: deps.now() });
    }
    const probes = pool.map(async (peer) => {
      deps.event({
        type: "pair:selected",
        cycleId: deps.cycleId,
        workingAgent: deps.workingAgent,
        peer,
        stage: deps.stage,
        timeoutMs: deps.timeoutMs,
        ...(reason !== undefined ? { reason: "fanout" } : {}),
        ts: deps.now(),
      });
      const review = await deps.reviewPeer(peer, deps.diff, deps.timeoutMs);
      return review === null ? null : { peer, sameTypeFallback: poolInfo.sameTypeFallback, review };
    });
    const winner = await firstValid(probes);
    if (winner === null) {
      return { status: "timeout", blocked: deps.blockOnNoWinner, sameTypeFallback: poolInfo.sameTypeFallback, skipped: [] };
    }
    return {
      status: "reviewed",
      blocked: false,
      peer: winner.peer,
      review: winner.review,
      sameTypeFallback: winner.sameTypeFallback,
      skipped: [],
    };
  }

  const out = await serialFirstValid<PairReview>(poolInfo.peers, async (peer, index) => {
    deps.event({
      type: "pair:selected",
      cycleId: deps.cycleId,
      workingAgent: deps.workingAgent,
      peer,
      stage: deps.stage,
      timeoutMs: deps.timeoutMs,
      attempt: index + 1,
      reason: index === 0 ? "ranked_candidate" : "fallback_after_failure",
      ts: deps.now(),
    });
    const review = await deps.reviewPeer(peer, deps.diff, deps.timeoutMs);
    return review === null ? null : { peer, value: review };
  });
  if (out.winner === null) {
    return { status: "timeout", blocked: deps.blockOnNoWinner, sameTypeFallback: poolInfo.sameTypeFallback, skipped: [] };
  }
  return {
    status: "reviewed",
    blocked: false,
    peer: out.winner.peer,
    review: out.winner.value,
    sameTypeFallback: poolInfo.sameTypeFallback,
    skipped: out.skipped,
  };
}

/**
 * Run one pairing for a cycle AT A GIVEN STAGE. Returns a status (callers/tests
 * assert on it); all side-effects go through the injected event sink + evidence
 * file. Never throws — pairing is an enhancement, never a cycle blocker.
 *
 * The scoped evaluator role enables the code-review stage. All PAIR-003
 * invariants (timeout, non-blocking behavior, and cost events) hold there.
 */
export async function runPairing(
  projectDir: string,
  worktreeCwd: string,
  runtimeDir: string,
  cycleId: string,
  workingAgent: string,
  stage: PairingStage,
  deps: RunPairingDeps,
): Promise<RunPairingResult> {
  try {
    if (stage === "score") return { status: "off" }; // belt-and-braces: score never routes through the review loop (US-PAIR-009)
    const loaded = loadPairingConfig(projectDir, deps.installed);
    if (loaded === null) return { status: "off" }; // file absent = pairing off
    const cfg = loaded.cfg;
    if (!cfg.enabled || !cfg.stages.includes(stage)) return { status: "off" };

    // Only pair a delivery worth a second pair of eyes (align with peer-gate).
    const files = await deps.changedFiles(worktreeCwd);
    if (!assessComplexity(files).high) return { status: "not-required" };

    const candidates = selectPairingCandidates({
      installed: deps.installed,
      isAvailable: deps.isAvailable,
      workingAgent,
      stage,
      cfg,
      cycleId,
      // US-PAIR-006: history-driven ε-greedy preference (no-op when absent).
      ...(deps.history !== undefined ? { history: deps.history } : {}),
      ...(deps.epsilon !== undefined ? { epsilon: deps.epsilon } : {}),
      // FIX-935: respect project-config agent allowlist.
      ...(deps.allowedAgents !== undefined && loaded.source !== "scoped-agents" ? { allowedAgents: deps.allowedAgents } : {}),
    });
    if (candidates.length === 0) {
      // fail-loud: no silent skip — the absence is itself an audited event.
      deps.event({ type: "pair:none-available", cycleId, stage, reason: "no qualified heterogeneous peer", ts: deps.now() });
      return { status: "none-available" };
    }

    const diff = await deps.diff(worktreeCwd);
    // empty diff → nothing to review; don't waste a peer or emit a selected event (pi pair-review).
    if (diff.trim() === "") return { status: "not-required" };

    // FIX-1054: SERIAL take-first is the DEFAULT. Try one ranked candidate at a
    // time; ANY structured verdict (agree/refine/object comes back non-null from
    // the seam) is accepted and stops dispatch — Roll never keeps shopping for a
    // more convenient reviewer. Fall back to the next candidate ONLY on a real
    // failure (timeout/auth/exit → null). Once accepted, the untried candidates
    // are SKIPPED (never spawned) and recorded as a policy decision. FIX-335's
    // parallel take-first survives ONLY as the explicit high-risk fan-out below.
    // FIX-363: budget scales with the diff the peer must actually read.
    const timeoutMs = deps.timeoutMs ?? reviewTimeoutMs(diff.length);
    const dispatched = await pairingDispatch({
      cycleId,
      workingAgent,
      stage,
      candidates: candidates.map((c) => c as string),
      mode: deps.fanout === undefined ? "serial-take-first" : "parallel-first-valid",
      fallbackPolicy: "none",
      sameTypeFallback: { allowed: false },
      blockOnNoWinner: false,
      diff,
      timeoutMs,
      reviewPeer: deps.reviewPeer,
      event: deps.event,
      now: deps.now,
      ...(deps.fanout !== undefined ? { fanoutReason: deps.fanout, fanoutLimit: PAIR_FANOUT_LIMIT } : {}),
    });
    if (dispatched.status !== "reviewed") {
      // Whole candidate pool failed (timeout/error) → block (no real hetero verdict).
      return { status: "timeout" };
    }
    if (dispatched.skipped.length > 0) {
      // Cost-aware: the untried ranked candidates are a POLICY skip (a reviewer
      // was accepted), not zero-cost attempted peers.
      deps.event({ type: "pair:skipped", cycleId, peers: dispatched.skipped, reason: "accepted_verdict", stage, ts: deps.now() });
    }
    const { peer, review } = dispatched;
    const path = evidencePath(runtimeDir, cycleId, stage);
    mkdirSync(join(runtimeDir, "peer"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ cycleId, workingAgent, peer, stage, ...review }, null, 2),
      "utf8",
    );
    deps.event({ type: "pair:verdict", cycleId, peer, verdict: review.verdict, findings: review.findings.length, cost: review.cost, stage, ts: deps.now() });
    return { status: "reviewed", peer, verdict: review.verdict };
  } catch {
    return { status: "error" }; // never throw — pairing must not fail the cycle
  }
}

// ── US-PAIR-009: score stage — the paired heterogeneous agent scores the cycle ─

/** A peer Reviewer's structured score for a finished cycle (the Review Score note shape). */
export interface PairScore {
  score: number;
  verdict: "good" | "ok" | "regression";
  rationale: string;
  cost: number;
  /** US-AGENT-041: the reviewer's optional "scope too large" signal — present
   *  only when the delivery is incomplete because the SCOPE exceeds one cycle
   *  (uncovered AC/coverage gaps), not a pure quality problem. Drives the
   *  post-cycle review-triggered self-downgrade. */
  resize?: ResizeSignal;
}

/**
 * FIX-1045: the outcome of parsing a peer's raw score reply. On failure it
 * carries a SPECIFIC reason (never a generic "unparseable") plus a category that
 * lets the role summary distinguish "returned score-like text but not accepted"
 * (`rejected-score-like`) from "no score content returned" (`no-score-content`).
 */
export type ScoreParseDiagnosis =
  | { ok: true; score: Omit<PairScore, "cost"> }
  | { ok: false; category: "no-score-content" | "rejected-score-like"; reason: string };

export interface RunScorePairingDeps {
  /** Installed agents (canonical). */
  installed: string[];
  /** Liveness probe over CANONICAL agent names. */
  isAvailable: (agent: string) => boolean;
  /** The peer reads the delivery summary and returns a structured score, or
   *  null on timeout/error (the hard timeout lives in the implementation). */
  scorePeer: (peer: string, summary: string, timeoutMs: number) => Promise<PairScore | null>;
  event: (e: PairEvent) => void;
  now: () => number;
  timeoutMs?: number;
  history?: PairingHistory;
  epsilon?: number;
  /** Note-writer seam (tests); defaults to {@link writeReviewScoreNote}. */
  writeNote?: typeof writeReviewScoreNote;
  /**
   * FIX-344 — the label the `pair:score` event, the reviewer session-id prefix,
   * and the evidence filename carry. Defaults to `"score"` (a build/fix loop
   * cycle's Review Score). `"design"` marks the roll-design peer Review Score
   * path: roll-design has NO loop cycle, so its independent score is triggered at
   * skill wrap-up and stamped `stage: "design"` so it is distinguishable in the
   * shared event stream. Candidate SELECTION is unchanged — both routes use the
   * mandatory same-vendor-fallback `"score"` selector (independence = a fresh
   * separately-spawned session, never vendor heterogeneity), so the design path
   * is NOT a new selection mode, only a distinct label + scoring prompt.
   */
  scoreStage?: "score" | "design";
  /**
   * FIX-935: project-config allowed agents (from `.roll/agents.yaml` slots).
   * When supplied, candidates are restricted to this set.
   */
  allowedAgents?: Set<string> | readonly string[];
  /**
   * FIX-1054: opt into an explicit, bounded high-risk score FAN-OUT (parallel
   * take-first) instead of the serial default. See {@link RunPairingDeps.fanout}.
   */
  fanout?: PairFanoutReason;
}

export interface RunScorePairingResult {
  // FIX-343 (step ④): the score stage is MANDATORY — there is no "off". A
  // non-"scored" status (none-available / timeout / error) is fail-loud and
  // BLOCKS the cycle (the attest gate then has no peer score to honor).
  status: "none-available" | "scored" | "timeout" | "error";
  peer?: string;
  score?: number;
  notePath?: string;
  /** The reviewer's fresh session/cast id recorded on the note (independence
   *  is verifiable, not asserted). Present on a "scored" result. */
  sessionId?: string;
  /**
   * US-CYCLE-008 — the ACTUAL panel composition: every peer a fresh evaluator
   * session was spawned for during this score stage, in spawn order, de-duped.
   * For a low-tier serial run this is normally one peer; for a high-tier fan-out
   * it is the bounded parallel pool. The round-journal records this against the
   * DECLARED tier so a readout can audit "declared vs actual". Always present
   * (possibly empty on a none-available short-circuit).
   */
  panel: string[];
}

/** FIX-343 (step ④): the per-attempt score timeout and the bounded retry budget
 *  (1 retry ⇒ 2 attempts max). A score-stage flake is an HONEST failure, not a
 *  fallback — the retry only reduces flake-driven false negatives.
 *  FIX-363: raised 120s → 180s to match the owner's ≤3min peer-review policy floor
 *  (the FIX-356b incident timed out the score reviewers too). This is a FLAT bump,
 *  NOT diff-scaled: the scorer reads a tiny `--stat` summary (≤4K), never the full
 *  diff, so it needs headroom for cold-spawn + reasoning, not for diff length. */
const SCORE_TIMEOUT_MS = 180_000;
const SCORE_MAX_ATTEMPTS = 2; // 1 initial + 1 bounded retry

/**
 * FIX-343 (step ④) — the score stage is the SOLE, MANDATORY producer of the
 * cycle's Review Score: a fresh-session peer reads the delivery summary and
 * writes the `scoring: pair` Review Score note. The working agent NEVER grades its own work.
 *
 *   • MANDATORY: NOT gated on `.roll/pairing.yaml` (enabled / stages⊇score). A
 *     delivery always owes a Review Score; the executor calls this every cycle.
 *   • SAME-VENDOR fresh session qualifies (selectPairingCandidates stage="score"
 *     drops the heterogeneity filter) — independence = a separately spawned
 *     fresh session (ports.agentSpawn forks a distinct subprocess), incl. a
 *     fresh instance of the builder's own type. NOT vendor heterogeneity.
 *   • FAIL-LOUD: no-winner / timeout / error → a non-"scored" status that
 *     BLOCKS (no synthesized fallback note). The attest gate then fails on
 *     "missing peer review score" and the cycle honestly fails.
 *   • The note records `scoring: pair` + `scored-by` + a unique `session-id`
 *     (the reviewer's fresh session/cast id) so independence is VERIFIABLE.
 *   • 1 bounded retry @ 120s/attempt to shave flake-driven honest failures.
 *
 * Validation is delegated to the FIX-274 writer (score 1..10 integer, verdict
 * whitelist): the note is written BEFORE the evidence file, so a malformed peer
 * score aborts with nothing on disk (status "error"). Once the note IS written
 * the pairing counts as scored — the evidence file + event are best-effort.
 */
export async function runScorePairing(
  projectDir: string,
  runtimeDir: string,
  cycleId: string,
  workingAgent: string,
  storyId: string,
  skill: string,
  summary: string,
  deps: RunScorePairingDeps,
): Promise<RunScorePairingResult> {
  try {
    // FIX-344: the OBSERVABILITY label (event/session-id/evidence file). Defaults
    // to "score" (a loop cycle's Review Score); "design" marks the no-cycle
    // roll-design path. Candidate SELECTION below is unchanged — it always uses
    // the mandatory "score" selector, so the design path reuses FIX-343's
    // independence machinery verbatim (fresh separate session, same-vendor
    // fallback), only the label differs.
    const scoreStage = deps.scoreStage ?? "score";
    // FIX-343 (step ④): MANDATORY — scoped evaluator candidates narrow scoring;
    // a synthesized minimal configuration is used when no scoped binding exists.
    const loaded = loadPairingConfig(projectDir, deps.installed, { enabled: true, stages: ["score"] as PairingStage[], capability: {} });
    const cfg = loaded?.cfg ?? { enabled: true, stages: ["score"] as PairingStage[], capability: {} };
    const selectionAllowedAgents = loaded?.source === "scoped-agents" ? Object.keys(cfg.capability) : deps.allowedAgents;

    const candidates = selectPairingCandidates({
      installed: deps.installed,
      isAvailable: deps.isAvailable,
      workingAgent,
      stage: "score",
      cfg,
      cycleId,
      ...(deps.history !== undefined ? { history: deps.history } : {}),
      ...(deps.epsilon !== undefined ? { epsilon: deps.epsilon } : {}),
      // FIX-935: respect project-config agent allowlist.
      ...(selectionAllowedAgents !== undefined ? { allowedAgents: selectionAllowedAgents } : {}),
    });
    // FIX-1044 (AC3/AC4): the escalation universe — installed, known, allowlisted
    // agents that are NOT the builder. The builder is never an independent
    // Evaluator (unless it is the sole installed agent, handled by the selector's
    // same-vendor round), so it is excluded here too. Computed up front so the
    // none-available short-circuit can tell "no independent scorer EXISTS at all"
    // (fail-loud, never self-score) from "the initial probe pool was empty but a
    // probe-missed independent can still be rescued by escalation" (FIX-911).
    const builderCanonical = canonicalAgentName(workingAgent);
    const escalationAllowedSet = selectionAllowedAgents === undefined ? undefined : new Set([...selectionAllowedAgents].map(canonicalAgentName));
    const escalationUniverse = deps.installed
      .map(canonicalAgentName)
      .filter((a, i, arr) => arr.indexOf(a) === i)
      .filter((a) => agentIsKnown(a))
      .filter((a) => escalationAllowedSet === undefined || escalationAllowedSet.has(a))
      .filter((a) => workingAgent.trim() === "" || a !== builderCanonical);
    if (candidates.length === 0 && escalationUniverse.length === 0) {
      // Fail-loud: no INDEPENDENT scorer exists to spawn a fresh session of, and
      // the builder is not an eligible fallback → BLOCK (no self-score, AC4).
      deps.event({ type: "pair:none-available", cycleId, stage: scoreStage, reason: "no independent scorer available to spawn a fresh review session", ts: deps.now() });
      return { status: "none-available", panel: [] };
    }

    const timeoutMs = deps.timeoutMs ?? SCORE_TIMEOUT_MS;
    // FIX-343 (② BOUNDED hetero preference): selectPairingCandidates already
    // ranks hetero-first, but at RUNTIME firstValid takes the FIRST responder, so
    // a same-vendor scorer that replies before a live hetero peer would win — the
    // hetero-first ordering was decorative. Make the preference REAL: split the
    // pool by vendor and run firstValid over the HETERO subset FIRST; only when
    // hetero is EMPTY or wholly fails (all-null/throw) within the SAME bounded
    // budget do we FALL BACK to the same-vendor subset. Prefer hetero → fall back
    // to same-vendor-fresh → NEVER hang (each round is bounded by the per-attempt
    // timeout + the 1-retry cap). Same-vendor-fresh still PASSES the gate (owner
    // minimum). A single-vendor install has an EMPTY hetero subset → it goes
    // straight to the same-vendor round (no wasted hetero wait).
    // C2 (FIX-343): guard the empty workingAgent label split so the bucketing
    // matches core/agent/pairing.ts selectPairingCandidates (which buckets ALL
    // candidates as same-vendor when `working === ""` — heterogeneity is
    // undefined without a known builder). `isHeterogeneous(c, "")` would
    // otherwise mark every real-vendor candidate "hetero", mislabeling the
    // telemetry round. Empty builder ⇒ everything is the same-vendor round.
    const builder = workingAgent.trim();
    const heteroPool = builder === "" ? [] : candidates.filter((c) => isHeterogeneous(c as string, builder));
    const sameVendorPool = builder === "" ? candidates : candidates.filter((c) => !isHeterogeneous(c as string, builder));

    // 1 bounded retry PER ROUND. Each attempt fires the round's pool in PARALLEL
    // (FIX-335 take-first) and uses the FIRST non-null score; the rest are
    // discarded. A wholly-flaking round retries ONCE (no death-spiral). The
    // reviewer's fresh session/cast id is minted per attempt so independence is
    // recorded on the note, not asserted.
    //
    // C1 (FIX-343): `coerceThrowToNull` makes a round's all-throw degrade to a
    // null (no winner) INSTEAD of propagating. The HETERO round is run with
    // coercion ON so a throwing hetero scorePeer falls THROUGH to the same-vendor
    // round (matching the comment "hetero EMPTY or wholly fails (all-null/throw) →
    // FALL BACK to same-vendor"). The TERMINAL (same-vendor) round keeps coercion
    // OFF: there is nothing left to fall back to, so a broken probe stays a defect
    // (firstValid re-throws → outer catch → status "error"), per FIX-335.
    type ScoreWinner = { peer: string; scored: PairScore; sessionId: string };
    const fanout = deps.fanout;
    // US-CYCLE-008 — the ACTUAL panel: every peer a fresh evaluator session is
    // spawned for, in spawn order, de-duped. Recorded against the DECLARED tier
    // so the round-journal can audit "declared vs actual" evaluation depth.
    const panel: string[] = [];
    const spawnScore = async (peer: string, attempt: number): Promise<ScoreWinner | null> => {
      if (!panel.includes(peer)) panel.push(peer);
      // FIX-344: the session-id prefix carries the score-stage label so a design
      // score's session is `${cycleId}:design:...` (distinguishable from a cycle's
      // `${cycleId}:score:...`); both remain a unique, verifiably-independent
      // fresh session id on the note.
      const sessionId = `${cycleId}:${scoreStage}:${peer}:a${attempt}:${deps.now()}`;
      deps.event({
        type: "pair:selected",
        cycleId,
        workingAgent,
        peer,
        stage: scoreStage,
        timeoutMs,
        attempt,
        reason: fanout !== undefined ? "fanout" : attempt > 1 ? "same_agent_or_fallback" : "ranked_candidate",
        ts: deps.now(),
      });
      const scored = await deps.scorePeer(peer, summary, timeoutMs);
      return scored === null ? null : { peer, scored, sessionId };
    };
    const runRound = async (pool: string[], coerceThrowToNull: boolean): Promise<ScoreWinner | null> => {
      if (pool.length === 0) return null; // empty pool → no winner (no spawn, no wait)
      // FIX-1054: an explicit high-risk fan-out fires the round in PARALLEL
      // (bounded to PAIR_FANOUT_LIMIT) and takes the first parseable score.
      if (fanout !== undefined) {
        const fpool = pool.slice(0, PAIR_FANOUT_LIMIT);
        deps.event({ type: "pair:fanout", cycleId, stage: scoreStage, reason: fanout, limit: PAIR_FANOUT_LIMIT, peers: fpool, ts: deps.now() });
        let w: ScoreWinner | null = null;
        for (let attempt = 1; attempt <= SCORE_MAX_ATTEMPTS && w === null; attempt++) {
          const probes = fpool.map((peer) => spawnScore(peer, attempt));
          if (coerceThrowToNull) {
            try { w = await firstValid(probes); } catch { w = null; }
          } else {
            w = await firstValid(probes);
          }
        }
        return w;
      }
      // FIX-1054 DEFAULT: SERIAL take-first. Try each candidate one at a time;
      // the first parseable score wins and the untried candidates are SKIPPED
      // (never spawned). A wholly-flaking round still retries ONCE (the bounded
      // SCORE_MAX_ATTEMPTS budget) so a transient flake doesn't false-negative.
      let w: ScoreWinner | null = null;
      let skipped: string[] = [];
      for (let attempt = 1; attempt <= SCORE_MAX_ATTEMPTS && w === null; attempt++) {
        const out = await serialFirstValid<PairScore>(pool, async (peer) => {
          const s = await spawnScore(peer, attempt);
          return s === null ? null : { peer: s.peer, value: s.scored };
        });
        if (out.winner !== null) {
          const peer = out.winner.peer;
          const sessionId = `${cycleId}:${scoreStage}:${peer}:a${attempt}:${deps.now()}`;
          w = { peer, scored: out.winner.value, sessionId };
          skipped = out.skipped;
        }
      }
      if (w !== null && skipped.length > 0) {
        deps.event({ type: "pair:skipped", cycleId, peers: skipped, reason: "accepted_score", stage: scoreStage, ts: deps.now() });
      }
      return w;
    };

    // Hetero FIRST (throws coerced → fall through); fall back to same-vendor only
    // when hetero is absent or wholly fails.
    let winner = await runRound(heteroPool, true);
    if (winner === null) winner = await runRound(sameVendorPool, false);
    if (winner === null) {
      // FIX-911 — pool-level escalation: before giving up, try ANY reachable
      // reviewer that was NOT in the candidate pool (excluded by isAvailable
      // probe) but IS installed + headless-capable. The probe can miss a
      // genuinely reachable peer (transient timeout, stale auth state); this
      // escalation gives them one more chance with a hard budget cap to avoid
      // death-spiralling on genuinely dead peers.
      const triedPeers = new Set([...heteroPool, ...sameVendorPool].map(canonicalAgentName));
      // FIX-1044: the escalation universe (installed, known, allowlisted, NON-builder)
      // was computed up front. The builder is never resurrected as a last-resort
      // scorer for its own cycle (AC3) — without this exclusion the builder,
      // already dropped by the probe, slipped back in as a self-score fallback
      // (the FIX-1042 cycle: builder=claude → escalated claude->claude).
      const escalationPool = escalationUniverse.filter((a) => !triedPeers.has(a));
      if (escalationPool.length > 0) {
        // Serial dispatch — we are budget-conscious and only need ONE score.
        // Parallel firstValid here would burn all candidates at once with no
        // budget awareness, and a fast-failing auth-block would waste a slot.
        const ESCALATION_MAX_ROUNDS = 2; // hard cap on escalation attempts
        const rounds = Math.min(ESCALATION_MAX_ROUNDS, escalationPool.length);
        for (let i = 0; i < rounds && winner === null; i++) {
          const peer = escalationPool[i] as string;
          // Single-peer round (escalation is serial, not parallel). Reuse the
          // same SCORE_MAX_ATTEMPTS budget per peer so a single flake doesn't
          // kill the round, but a dead peer doesn't spiral either.
          const singlePool = [peer];
          // coerceThrowToNull=false: the escalation is the last resort, so a
          // broken probe (throw) is a defect → status "error", per FIX-335.
          winner = await runRound(singlePool, false);
        }
      }
    }
    if (winner === null) {
      // All rounds (hetero, same-vendor, escalation) exhausted → honest timeout, BLOCK.
      return { status: "timeout", panel };
    }
    const { peer, scored, sessionId } = winner;

    // Note first (the writer is the validator): a bad peer payload throws here
    // and leaves NOTHING on disk — no evidence, no event, status "error".
    const note = (deps.writeNote ?? writeReviewScoreNote)(projectDir, {
      skill,
      story: storyId,
      score: scored.score,
      verdict: scored.verdict,
      rationale: scored.rationale,
      scoredBy: peer,
      scoring: "pair",
      sessionId,
      // US-AGENT-041: persist the reviewer's scope-resize signal (if any) so the
      // post-cycle review-resize trigger can act on it.
      ...(scored.resize !== undefined ? { resize: scored.resize } : {}),
    });

    try {
      const path = evidencePath(runtimeDir, cycleId, scoreStage);
      mkdirSync(join(runtimeDir, "peer"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ cycleId, workingAgent, peer, stage: scoreStage, score: scored.score, verdict: scored.verdict, rationale: scored.rationale, cost: scored.cost, sessionId }, null, 2),
        "utf8",
      );
      deps.event({ type: "pair:score", cycleId, peer, score: scored.score, verdict: scored.verdict, cost: scored.cost, stage: scoreStage, ts: deps.now() });
    } catch {
      /* evidence/event are auxiliaries — the note is the product */
    }
    return { status: "scored", peer, score: scored.score, notePath: note.path, sessionId, panel };
  } catch {
    return { status: "error", panel: [] }; // never throw — scoring must not fail the cycle
  }
}

// ── FIX-1044: tolerant score-output normalization ───────────────────────────
// Real Evaluator stdout wraps the SCORE/VERDICT/RATIONALE protocol in noise that
// the old strict line scan rejected even when a valid block was present:
//   • pi prints a terminal overstrike (`^D` then two backspaces erase it) before SCORE,
//   • reasonix prints startup warnings + an ANSI TUI transcript above the block,
//   • claude emits JSONL stream events whose FINAL {"type":"result",...,"result":"…"}
//     object carries the protocol text (escaped newlines, not real lines),
//   • kimi prefixes the block with a "• " bullet.
// We NORMALIZE — unwrap JSONL → apply backspaces → strip ANSI/control bytes —
// BEFORE the STRICT extraction. Validation is NEVER relaxed: a single complete
// in-order SCORE/VERDICT/RATIONALE block with an in-range score and a supported
// verdict is still required after normalization (so arbitrary prose, duplicate
// fields, out-of-range scores, and unsupported verdicts still parse to null).

// CSI/OSC escape sequences (shared shape with watch-status/watch-render).
const SCORE_ANSI_RE =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Apply terminal backspace (0x08) semantics: each BS erases the preceding
 *  character on its line (the overstrike pattern `X\b` renders as nothing). A BS
 *  with nothing before it on the line is dropped; a newline is a hard boundary.
 *  Turns pi's `^D\b\bSCORE` into `SCORE`. */
function applyBackspaces(text: string): string {
  if (!text.includes("\b")) return text;
  const out: string[] = [];
  for (const ch of text) {
    if (ch === "\b") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "\n" && last !== "\r") out.pop();
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

/** Stream-json stdout: each line is a JSON event; the agent's actual reply lives
 *  in the LAST object carrying a string `result` field ({"type":"result",…}).
 *  JSON.parse turns its escaped `\n` into real newlines. null when stdout is not
 *  JSONL-wrapped (plain-text agents) → the caller parses the raw text. */
function unwrapJsonlResult(stdout: string): string | null {
  let payload: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t[0] !== "{") continue;
    try {
      const obj = JSON.parse(t) as { result?: unknown };
      if (typeof obj.result === "string") payload = obj.result; // keep the LAST result
    } catch {
      /* not a JSON event line — ignore */
    }
  }
  return payload;
}

/** Normalize raw Evaluator stdout to the plain protocol text: unwrap JSONL,
 *  collapse backspaces, strip ANSI escapes, then drop residual C0 control bytes
 *  (keeping TAB/LF/CR). Bounded and lossless for the protocol lines themselves. */
export function normalizeScoreStdout(stdout: string): string {
  const text = unwrapJsonlResult(stdout) ?? stdout;
  return applyBackspaces(text)
    .replace(SCORE_ANSI_RE, "")
    // residual C0 control bytes (NUL..BS, VT, FF, SO..US, DEL) — keep TAB/LF/CR
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // FIX-1045: normalize ALL line breaks to \n so the line scan sees every
    // protocol line. A TUI soft-wraps a long rationale with a bare CR (U+000D)
    // or a Unicode line/paragraph separator (U+2028/U+2029); the scan splits on
    // \r?\n only, so without this the wrapped RATIONALE text is invisible and a
    // valid final block is mis-rejected as "missing RATIONALE".
    .replace(/\r\n/g, "\n")
    .replace(/[\r\u2028\u2029]/g, "\n");
}

/** Strip leading bullet/markdown decoration (`**`, `•`, `-`, `#`, `>`, spaces)
 *  and trailing markdown/space so a decorated marker line (`**SCORE: 10**`,
 *  `• SCORE: 8`) still matches the STRICT protocol regex. Only leading
 *  non-content punctuation is removed — `SCORE:`/`VERDICT:`/`RATIONALE:` itself,
 *  the score digits, and the verdict word are untouched. */
function stripScoreLineDecoration(line: string): string {
  return line.replace(/^[\s>*#•‣◦⁃·▪⁃-]+/, "").replace(/[\s*]+$/, "");
}

/** A RATIONALE value that is only a `<placeholder>` echo of the reply template
 *  (`RATIONALE: <one sentence>`) or empty — NOT a real rationale. Used to drop
 *  template-echo blocks (kimi prints the contract template before its real reply)
 *  so they never count as the final usable block. */
function isPlaceholderRationale(text: string): boolean {
  const t = text.trim();
  return t === "" || /^<[^>]*>$/.test(t);
}

/**
 * FIX-1045: the diagnostic core of score parsing. Returns the parsed block on
 * success, or a precise failure reason (never a generic "unparseable") split
 * into two observable categories so the role summary can tell apart:
 *   - `no-score-content`     — the reply has NO SCORE/VERDICT/RATIONALE markers
 *                              at all (e.g. agy returned prose / an empty TUI).
 *   - `rejected-score-like`  — the reply DID return score-like text but it is not
 *                              acceptable (template echo, conflicting duplicate
 *                              blocks, missing field, out-of-range score,
 *                              unsupported verdict, no in-order final block).
 *
 * Compatibility (the FIX-1045 gap): real agents emit the SAME final block more
 * than once. reasonix repaints its TUI so the `SCORE/VERDICT/RATIONALE` block
 * appears twice (the redraw); kimi prints the reply template, then its analysis,
 * then the real block last. The old parser required EXACTLY ONE of each marker
 * line, so both returned null even though a single final block could be cleanly
 * isolated. We now isolate the FINAL in-order block and accept it WHEN the
 * score-bearing blocks RESOLVE to one answer (every valid SCORE line agrees, every
 * valid VERDICT line agrees) — a redraw is resolved, a genuine disagreement is not.
 * Validation is NOT relaxed: arbitrary prose, template echoes, conflicting blocks,
 * out-of-range scores, and unsupported verdicts still fail.
 */
export function diagnosePairScoreOutput(stdout: string): ScoreParseDiagnosis {
  const normalized = normalizeScoreStdout(stdout);
  const lines = normalized.split(/\r?\n/).map(stripScoreLineDecoration);

  // Any line that even LOOKS like a protocol marker (incl. template echoes /
  // out-of-range / bad verdicts). Distinguishes "returned score-like text but not
  // accepted" from "no score content returned".
  const hasScoreLike = lines.some((line) => /^(SCORE|VERDICT|RATIONALE):/i.test(line));
  if (!hasScoreLike) {
    return { ok: false, category: "no-score-content", reason: "no SCORE/VERDICT/RATIONALE content returned" };
  }

  // A SCORE line with a numeric value, regardless of range (used to tell an
  // out-of-range score apart from a missing one).
  const numericScoreLines = lines.filter((line) => /^SCORE:\s*\d{1,2}$/i.test(line));
  const scoreMarks = lines
    .map((line, index) => ({ index, match: /^SCORE:\s*(\d{1,2})$/i.exec(line) }))
    .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null)
    .filter((entry) => {
      const v = Number(entry.match[1]);
      return Number.isInteger(v) && v >= 1 && v <= 10;
    });
  const verdictMarks = lines
    .map((line, index) => ({ index, match: /^VERDICT:\s*(good|ok|regression)$/i.exec(line) }))
    .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null);
  const rationaleMarks = lines
    .map((line, index) => ({ index, match: /^RATIONALE:\s*(.+)$/i.exec(line) }))
    .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null)
    .filter((entry) => !isPlaceholderRationale(entry.match[1]!));

  if (scoreMarks.length === 0) {
    return numericScoreLines.length > 0
      ? { ok: false, category: "rejected-score-like", reason: "SCORE value out of range (must be 1..10)" }
      : { ok: false, category: "rejected-score-like", reason: "no valid SCORE line (need `SCORE: <1..10>`)" };
  }
  if (verdictMarks.length === 0) {
    return { ok: false, category: "rejected-score-like", reason: "no supported VERDICT line (need good|ok|regression)" };
  }
  if (rationaleMarks.length === 0) {
    return { ok: false, category: "rejected-score-like", reason: "missing RATIONALE line (template/placeholder echoes do not count)" };
  }

  // Duplicate UNRESOLVED blocks: a redraw repeats the SAME answer (one distinct
  // score, one distinct verdict) and is accepted; genuinely conflicting blocks
  // (different scores or verdicts) are ambiguous and rejected.
  const distinctScores = [...new Set(scoreMarks.map((m) => m.match[1]))];
  const distinctVerdicts = [...new Set(verdictMarks.map((m) => m.match[1]!.toLowerCase()))];
  if (distinctScores.length > 1) {
    return { ok: false, category: "rejected-score-like", reason: `conflicting duplicate score blocks (SCORE ${distinctScores.join(" vs ")})` };
  }
  if (distinctVerdicts.length > 1) {
    return { ok: false, category: "rejected-score-like", reason: `conflicting duplicate verdict blocks (VERDICT ${distinctVerdicts.join(" vs ")})` };
  }

  // Isolate the FINAL block: the last marker of each kind, in protocol order.
  const sm = scoreMarks[scoreMarks.length - 1]!;
  const vm = verdictMarks[verdictMarks.length - 1]!;
  const rm = rationaleMarks[rationaleMarks.length - 1]!;
  if (!(sm.index < vm.index && vm.index < rm.index)) {
    return { ok: false, category: "rejected-score-like", reason: "no in-order final SCORE→VERDICT→RATIONALE block" };
  }

  // US-AGENT-041: capture an optional RESIZE/GAPS signal (scope-too-large). The
  // low-score floor is applied later by `shouldResize`; here we just carry it.
  const resize = parseResizeSignal(normalized);
  return {
    ok: true,
    score: {
      score: Number(sm.match[1]),
      verdict: vm.match[1]!.toLowerCase() as PairScore["verdict"],
      rationale: rm.match[1]!.trim(),
      ...(resize !== null ? { resize } : {}),
    },
  };
}

/**
 * Parse a peer's score reply (the executor/manual command's stdout contract):
 * one `SCORE: <1..10>` line, one `VERDICT: good|ok|regression` line, one
 * `RATIONALE: <text>` line — anything missing/malformed → null (the round
 * treats it as no-score; a peer that can't follow the protocol never writes a note).
 *
 * Thin wrapper over {@link diagnosePairScoreOutput} (which carries the precise
 * failure reason for observability). The input is NORMALIZED first
 * ({@link normalizeScoreStdout}) so real agent output (terminal overstrike, ANSI
 * banners, JSONL wrappers, bullet prefixes, TUI redraws, template echoes) reaches
 * the strict scan as clean protocol lines; validation itself is never relaxed.
 */
export function parsePairScoreOutput(stdout: string): Omit<PairScore, "cost"> | null {
  const d = diagnosePairScoreOutput(stdout);
  return d.ok ? d.score : null;
}

// ── FIX-293: the peer-gate retry consult ─────────────────────────────────────

export interface RetryPeerConsultDeps {
  /** Installed agents (canonical), e.g. agentsInstalled(realAgentEnv()). */
  installed: string[];
  /** The agent that did the work — its heterogeneous peer is the reviewer. */
  workingAgent: string;
  /** One-way review (the existing consult closure): the peer reads the diff and
   *  returns a verdict, or null on timeout/error. The 30s hard timeout lives in
   *  the implementation — this retry respects it (a flaky peer can't spiral). */
  reviewPeer: (peer: string, diff: string, timeoutMs: number) => Promise<PairReview | null>;
  /** Full cycle diff the peer reviews. */
  diff: (worktreeCwd: string) => Promise<string>;
  event: (e: PairEvent) => void;
  now: () => number;
  /** Override the 30s default (tests). */
  timeoutMs?: number;
  /**
   * FIX-935: project-config allowed agents (from `.roll/agents.yaml` slots).
   * When supplied, candidates are restricted to this set.
   */
  allowedAgents?: Set<string> | readonly string[];
}

export interface RetryPeerConsultResult {
  status: "none-available" | "reviewed" | "timeout" | "empty" | "error";
  peer?: string;
  /** true when no heterogeneous peer was installed and the reviewer fell back to
   *  a fresh SEPARATE-SESSION instance of the working agent's own type (still a
   *  distinct spawned process, never the builder's session). For diagnostics. */
  sameTypeFallback?: boolean;
}

/**
 * FIX-293 — re-attempt the peer consultation ONCE when the peer gate blocks a
 * high-complexity delivery that shipped with no peer review.
 *
 * Unlike {@link runPairing} this is NOT gated on `.roll/pairing.yaml`: the peer
 * gate is the always-on, agent-agnostic safety mechanism (pairing is the opt-in
 * enhancement), so the block-triggered retry must fire whether or not pairing is
 * configured. It runs the SAME `reviewPeer` consult path the pairing gate uses,
 * with the SAME 30s hard timeout, and on a real verdict writes the canonical
 * peer-gate evidence file (`<rt>/peer/cycle-<id>.pair.json`) so a re-run of the
 * gate sees evidence and unblocks. Never throws — the retry is a best-effort
 * rescue, not a new way to topple a cycle.
 *
 * FIX-293 follow-up (owner ruling) — reviewer allocation by the cross-agent
 * strategy, with precedence:
 *   1. Heterogeneous peer PREFERRED — the first different-vendor installed agent
 *      (registry order, so the choice is deterministic, no `if agent==='x'`).
 *   2. FALLBACK: the working agent's OWN canonical type — `reviewPeer` spawns it
 *      as a FRESH, SEPARATE-SESSION subprocess (ports.agentSpawn always forks a
 *      new process), so a single-coding-agent environment is no longer
 *      permanently blocked. A different instance of the same type is acceptable.
 *   3. THE RED LINE: the reviewer is ALWAYS a separately-spawned session — never
 *      the builder's own session self-scoring its own work. The builder is the
 *      executor process; `reviewPeer` → `ports.agentSpawn` is a distinct child,
 *      so same-type here is a separate session, never in-session self-review.
 *   4. BLOCK only when even that separate-session consult yields no evidence
 *      (timeout / error / empty diff). With the same-type fallback "no peer at
 *      all" is rare — the block becomes "the separate-session review produced no
 *      evidence", not "no heterogeneous agent installed".
 *
 * Agent-agnostic by construction: the allocation (heterogeneous-preferred,
 * same-type-fallback) lives here in the normalization layer; the gate downstream
 * keys only on "separate-session peer evidence present?", with no per-agent
 * special-casing.
 */
export async function retryPeerConsult(
  worktreeCwd: string,
  runtimeDir: string,
  cycleId: string,
  deps: RetryPeerConsultDeps,
): Promise<RetryPeerConsultResult> {
  try {
    const working = canonicalAgentName(deps.workingAgent);
    const allowedSet = deps.allowedAgents === undefined ? undefined : new Set([...deps.allowedAgents].map(canonicalAgentName));
    const distinct = deps.installed
      .map(canonicalAgentName)
      .filter((a, i, arr) => arr.indexOf(a) === i)
      .filter((a) => agentIsKnown(a))
      // FIX-935: peer-gate retry must not auto-enable machine-detected agents
      // outside the project's `.roll/agents.yaml` allowlist.
      .filter((a) => allowedSet === undefined || allowedSet.has(a));
    // FIX-331 (+ codex peer-review): rotate through EVERY heterogeneous peer so one
    // peer's transient unavailability (claude 5h limit / kimi cold-start timeout)
    // doesn't sink the consult. Upholds FIX-293's HARD gate:
    //   • heterogeneous peers PREFERRED — when ANY exist we rotate through them
    //     ONLY and BLOCK if they all fail; a wholly-failing hetero pool must NOT
    //     degrade to a same-type / self review (that would weaken the gate).
    //   • the same-type SEPARATE-SESSION fallback fires ONLY when zero hetero peers
    //     are installed (single-vendor env — FIX-293's "not permanently blocked"):
    //     still a fresh distinct subprocess, never the builder's own session.
    const heteroPeers = distinct.filter((a) => a !== working && isHeterogeneous(a, working));
    const canSpawnSameType = working !== "" && distinct.includes(working);
    // The only true "no peer to consult" case: we don't even know the working
    // agent's type (no installed agent AND no working-agent name) — there is
    // nothing to spawn a separate session of. This is now rare (it is NOT "only
    // one vendor installed"); audited as a fail-loud absence.
    if (heteroPeers.length === 0 && !canSpawnSameType) {
      deps.event({ type: "pair:none-available", cycleId, stage: "code", reason: "peer-gate retry: no peer could be consulted (no agent to spawn a separate-session review)", ts: deps.now() });
      return { status: "none-available" };
    }
    const diff = await deps.diff(worktreeCwd);
    if (diff.trim() === "") return { status: "empty" };

    // FIX-335 AC3: PARALLEL take-first over the ordered pool. The pool is ALWAYS
    // homogeneous in fallback class — it is EITHER every heterogeneous peer OR a
    // single same-type fallback (built above), never mixed — so firing the whole
    // pool concurrently and taking the first non-null verdict preserves FIX-293's
    // hard gate exactly: a wholly-failing hetero pool still BLOCKS (timeout) and
    // never silently degrades to a same-type review. Only the dispatch is now
    // concurrent. `sameTypeFallback` is uniform across the pool, so the all-fail
    // status can carry it directly.
    // FIX-363: the peer-gate retry reads the SAME full diff as the pairing review,
    // so it gets the SAME diff-scaled budget (the FIX-356b block fired here too).
    const timeoutMs = deps.timeoutMs ?? reviewTimeoutMs(diff.length);
    const dispatched = await pairingDispatch({
      cycleId,
      workingAgent: working,
      stage: "code",
      candidates: heteroPeers,
      mode: "parallel-first-valid",
      fallbackPolicy: "same-type-when-primary-empty",
      sameTypeFallback: { allowed: canSpawnSameType, peer: working },
      blockOnNoWinner: true,
      diff,
      timeoutMs,
      reviewPeer: deps.reviewPeer,
      event: deps.event,
      now: deps.now,
    });
    if (dispatched.status !== "reviewed") {
      if (dispatched.status === "none-available") {
        deps.event({ type: "pair:none-available", cycleId, stage: "code", reason: "peer-gate retry: no peer could be consulted (no agent to spawn a separate-session review)", ts: deps.now() });
        return { status: "none-available" };
      }
      // Whole ordered pool failed (timeout/error) → stays blocked, no death-spiral.
      return { status: "timeout", sameTypeFallback: dispatched.sameTypeFallback };
    }
    const { peer, sameTypeFallback, review } = dispatched;
    const path = evidencePath(runtimeDir, cycleId, "code");
    mkdirSync(join(runtimeDir, "peer"), { recursive: true });
    writeFileSync(path, JSON.stringify({ cycleId, workingAgent: working, peer, stage: "code", sameTypeFallback, ...review }, null, 2), "utf8");
    deps.event({ type: "pair:verdict", cycleId, peer, verdict: review.verdict, findings: review.findings.length, cost: review.cost, stage: "code", ts: deps.now() });
    return { status: "reviewed", peer, sameTypeFallback };
  } catch {
    return { status: "error" }; // never throw — the retry is a rescue, not a cycle killer
  }
}

/**
 * The score-stage prompt (shared by the loop executor and `roll pair score`).
 *
 * US-SKILL-030 — when the story's spec carries an `**Evaluation contract:**`
 * block, the caller passes its formatted summary here so the peer scorer can
 * grade the delivery against the Designer contract evidence expectations, not just the
 * delivered summary. Absent (legacy stories) → no behavior change.
 */
export function buildPairScorePrompt(summary: string, evalContractSummary?: string): string {
  const contractBlock = evalContractSummary !== undefined && evalContractSummary !== ""
    ? `\nEVALUATION CONTRACT (Designer contract evidence from the story spec — grade against this):\n${evalContractSummary}\n`
    : "";
  return (
    `You are a heterogeneous PAIRING scorer. A different agent delivered the cycle below; ` +
    `grade the delivery quality honestly (root-cause depth, test coverage, scope discipline, evidence). ` +
    // FIX-363: grade against the STATED GOAL (the "Goal:" line). Removal / retire /
    // refactor cards are deletion-heavy BY DESIGN — a large deletion is NOT itself a
    // regression or poor scope discipline. A scorer that didn't know the goal was a
    // removal scored a clean `roll-sentinel` deletion 3/10 "regression" and blocked a
    // correct delivery (the loop then jammed on it).
    `Grade against the delivery's STATED GOAL shown on the "Goal:" line. ` +
    `If that goal is to REMOVE / RETIRE / DELETE / DROP / REFACTOR something, deletions ARE the intended ` +
    `deliverable: score whether the removal is CLEAN and COMPLETE (no dangling references, tests and docs follow, ` +
    `build stays green) — do NOT treat the deletion volume, or the absence of "replacement" code the goal never ` +
    `asked for, as a regression. ` +
    `Reply with exactly one "SCORE: <integer 1..10>" line, one "VERDICT: good|ok|regression" line, ` +
    `and one "RATIONALE: <one sentence>" line. ` +
    // US-AGENT-041: distinguish a SCOPE problem from a quality one. When the
    // delivery is incomplete because the story was simply too big for one cycle
    // (whole ACs / surfaces left uncovered, not bugs), ALSO add a "RESIZE: <why>"
    // line and a "GAPS: <gap one; gap two; ...>" line enumerating the uncovered
    // scope. The loop uses this to re-split the story (heterogeneous-consensus
    // gated), NOT to fail it. Omit RESIZE/GAPS for a pure quality problem.\n` +
    `If — and ONLY if — the low score is because the SCOPE is too large for one cycle (entire ACs or ` +
    `surfaces left uncovered, not defects), add a "RESIZE: <one line why>" line and a ` +
    `"GAPS: <gap one; gap two; ...>" line listing the uncovered scope. Do NOT add them for a quality problem.` +
    `${contractBlock}\nDELIVERY:\n` +
    summary
  );
}

// ── FIX-387: review prompt with repo context + build/TCR trust ──────────────

export interface ReviewPromptContext {
  diff: string;
  /** Number of commits ahead of main on this cycle's branch. */
  commitsAhead: number;
  /** Number of `tcr:` commits — evidence the build/TCR passed green. */
  tcrCount: number;
}

/**
 * FIX-387 — build the peer-review prompt with REPO CONTEXT so the reviewer knows:
 * (a) the build already passed (TCR green) — don't flag imports as build regression,
 * (b) symbols imported but not defined in the diff exist on the main baseline.
 *
 * Before this fix, the reviewer saw ONLY the diff and flagged `import { X }` as
 * "missing definition / build regression" when X was defined on main (outside the
 * diff). This feeds the reviewer the build/TCR facts and an explicit instruction
 * to avoid that mis-classification.
 *
 * AC4 guarantee: the instruction does NOT weaken detection of genuinely broken
 * code — the reviewer is still told to flag real issues INSIDE the diff or real
 * build failures, just not to mistake baseline imports for missing source.
 */
export function buildReviewPrompt(ctx: ReviewPromptContext): string {
  const buildLine =
    ctx.commitsAhead > 0
      ? `BUILD STATUS: ${ctx.commitsAhead} commit(s) ahead of main, ` +
        `${ctx.tcrCount > 0 ? `${ctx.tcrCount} TCR ` : ""}green — ` +
        `the build/TCR pipeline already passed. ` +
        `Do NOT flag imports, type references, or function calls to symbols defined ` +
        `OUTSIDE this diff (on the main baseline branch) as "build regression", ` +
        `"missing source", "undefined import", or "would fail build". ` +
        `The compiler already found those definitions on main.\n`
      : "";

  return (
    `You are a heterogeneous PAIRING reviewer — a DIFFERENT agent wrote the diff below. ` +
    `Your ONLY job is a terse second-pair-of-eyes review (correctness, edge cases, quality). ` +
    `Do NOT modify files, do NOT commit, do NOT try to "complete" or deliver anything — just review. ` +
    // FIX-387: trust the build/TCR pipeline that already passed. A symbol imported
    // but defined in a file UNCHANGED by this diff exists on the `main` baseline
    // and was resolved by the compiler — do NOT flag it as a build regression.
    `REPO CONTEXT: ` +
    `The branch targets \`origin/main\`; all files NOT listed in this diff are ` +
    `UNCHANGED from main and their contents (including exported symbols, types, ` +
    `and functions) exist on the baseline. ` +
    `\n` +
    (buildLine !== "" ? `TRUST BUILD: ${buildLine}` : "") +
    `Important — judge the diff ITSELF for correctness: ` +
    `  • Flag real bugs, logic errors, missing error handling, security issues, ` +
    `    broken patterns, or inconsistent changes WITHIN the diff. ` +
    `  • BUT if the diff IMPORTS a symbol / type / function and you cannot find ` +
    `    its definition WITHIN the diff → that symbol lives on main (the baseline) ` +
    `    and the compiler already resolved it. This is NORMAL — do NOT flag it. ` +
    `  • The ONLY time a missing import is real: the import path ITSELF is newly ` +
    `    introduced in this diff AND the file it points to is also in this diff BUT ` +
    `    missing the exported symbol. ` +
    `End with exactly one line "VERDICT: agree|refine|object" and one ` +
    `"FINDING: <issue>" line per concrete issue.\n\nDIFF:\n` +
    ctx.diff
  );
}

/**
 * FIX-344 — the DESIGN score-stage prompt. roll-design produces backlog/spec
 * artifacts (INVEST stories), NOT a code diff, so the scorer grades DESIGN
 * quality, not code: INVEST story split, visual-AC completeness (every
 * user-visible story carries a visual-evidence AC or an honest `screenshot_exempt`
 * reason), deliverable declarations (`deliverable_url` points at the real product
 * surface, not the card's own dossier), and domain/spec consistency (backlog rows
 * match spec files; no jump from idea straight to stories without a worked design
 * sample). The SAME structured reply contract as {@link buildPairScorePrompt} so
 * {@link parsePairScoreOutput} parses both identically and the note shape is shared.
 */
export function buildDesignScorePrompt(summary: string): string {
  return (
    `You are an independent DESIGN Reviewer. A different agent produced the design output below ` +
    `(backlog rows + story specs from a roll-design session), NOT code. ` +
    `Grade the DESIGN quality honestly — NOT code, there is no diff to read. Judge: ` +
    `(1) INVEST story split (each story independent, negotiable, valuable, estimable, small, testable; ` +
    `right granularity — not a mega-story, not noise); ` +
    `(2) visual-AC completeness (every user-visible story carries a visual-evidence AC, or an honest ` +
    `\`screenshot_exempt: <reason>\` — a naked exemption with no reason is a defect); ` +
    `(3) deliverable declarations (\`deliverable_url\`/\`screenshot_url\` points at the REAL product surface, ` +
    `never the card's own dossier/report page); ` +
    `(4) domain & spec consistency (backlog index rows match the spec files; a concrete worked design ` +
    `precedes decomposition — no idea-straight-to-stories with shallow specs). ` +
    `Grade against the design's STATED GOAL shown on the "Goal:" line if present. ` +
    `Reply with exactly one "SCORE: <integer 1..10>" line, one "VERDICT: good|ok|regression" line, ` +
    `and one "RATIONALE: <one sentence>" line.\n\nDESIGN OUTPUT:\n` +
    summary
  );
}
