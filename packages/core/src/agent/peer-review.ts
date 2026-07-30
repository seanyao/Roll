import { heterogeneousByModel, type ModelResolver } from "./isolation.js";
import { agentVendor, isHeterogeneous } from "./pairing.js";
import { agentIsKnown, canonicalAgentName } from "./registry.js";

export type PeerReviewMode = "auto" | "hetero" | "self";
export type PeerReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "TIMEOUT" | "ERROR";
export type ReviewerKind = "external" | "auxiliary" | "unknown";

export interface ParsedPeerReview {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  reason: string;
  findings: string[];
}

export interface PeerReviewerInput {
  mode: PeerReviewMode;
  candidates: readonly string[];
  workerAgents: readonly string[];
  requestedReviewer?: string;
  /**
   * US-PAIR-015: agent → resolved model. When supplied, heterogeneity is judged on
   * the MODEL's vendor instead of the agent-entry name — so two entries pinned to
   * one model (this repo: `pi` and `reasonix` → `deepseek-v4-pro`) stop counting as
   * a heterogeneous pair. Omitted → the legacy name comparison, which can
   * OVER-count; callers with repo access should always pass it.
   */
  resolveModel?: ModelResolver;
}

export type PeerReviewerUnavailableReason =
  | "no_installed_reviewer"
  | "no_external_reviewer"
  | "no_heterogeneous_reviewer"
  | "requested_reviewer_is_auxiliary"
  | "requested_reviewer_unavailable";

export type PeerReviewerSelection =
  | {
      status: "selected";
      effectiveMode: "hetero" | "self";
      reviewer: string;
      provider: string;
      degraded: boolean;
      reason?: string;
    }
  | {
      status: "unavailable";
      reason: PeerReviewerUnavailableReason;
    };

/** One ranked peer reviewer candidate returned by {@link selectPeerReviewers}. */
export interface PeerReviewerCandidate {
  effectiveMode: "hetero" | "self";
  reviewer: string;
  provider: string;
  degraded: boolean;
  reason?: string;
}

export type PeerReviewersSelection =
  | { status: "selected"; reviewers: PeerReviewerCandidate[] }
  | { status: "unavailable"; reason: PeerReviewerUnavailableReason };

export interface PeerReviewFacts {
  agent: string;
  provider: string;
  commandFamily: string;
  effectiveMode?: "hetero" | "self";
  verdict: PeerReviewVerdict;
  reason: string;
  findings: string[];
  durationMs: number;
  transcriptPath?: string;
  evidencePath?: string;
  error?: string;
  degradedReason?: string;
}

function uniqueCanonical(agents: readonly string[]): string[] {
  const out: string[] = [];
  for (const agent of agents) {
    const canonical = canonicalAgentName(agent.trim());
    if (canonical === "" || out.includes(canonical)) continue;
    out.push(canonical);
  }
  return out;
}

export function reviewerKind(agent: string): ReviewerKind {
  const raw = agent.trim().toLowerCase();
  if (raw === "" || /^codex-subagent[:/]/.test(raw) || /^subagent[:/]/.test(raw)) return "auxiliary";
  const canonical = canonicalAgentName(raw);
  return agentIsKnown(canonical) ? "external" : "unknown";
}

function externalReviewers(candidates: readonly string[]): string[] {
  return uniqueCanonical(candidates).filter((agent) => reviewerKind(agent) === "external");
}

function firstSelfReviewer(candidates: readonly string[], workers: readonly string[]): string | undefined {
  const installed = externalReviewers(candidates);
  const canonicalWorkers = uniqueCanonical(workers);
  return canonicalWorkers.find((agent) => installed.includes(agent)) ?? installed[0];
}

function selfReviewers(candidates: readonly string[], workers: readonly string[]): string[] {
  const canonicalWorkers = uniqueCanonical(workers);
  const out: string[] = [];
  // Prefer the current worker(s) when they are installed reviewers.
  for (const worker of canonicalWorkers) {
    if (candidates.includes(worker) && !out.includes(worker)) out.push(worker);
  }
  // Then any other installed external reviewer as rotation fallback.
  for (const agent of candidates) {
    if (!out.includes(agent)) out.push(agent);
  }
  return out;
}

function isHeterogeneousFromWorkers(
  agent: string,
  workers: readonly string[],
  resolveModel?: ModelResolver,
): boolean {
  const differs = (worker: string): boolean =>
    resolveModel !== undefined ? heterogeneousByModel(worker, agent, resolveModel) : isHeterogeneous(worker, agent);
  return workers.length === 0 || workers.every(differs);
}

function candidateRecord(agent: string, mode: "hetero" | "self", degraded: boolean, reason?: string): PeerReviewerCandidate {
  return { effectiveMode: mode, reviewer: agent, provider: agentVendor(agent), degraded, reason };
}

/**
 * FIX-336 — return a ranked list of peer reviewer candidates so consumers can
 * rotate through heterogeneous peers before falling back to self-review. Empty
 * list semantics are preserved as `unavailable`; `selectPeerReviewer` remains a
 * thin wrapper that returns the first (or unavailable) for backward compatibility.
 */
export function selectPeerReviewers(input: PeerReviewerInput): PeerReviewersSelection {
  const candidates = externalReviewers(input.candidates);
  const workers = uniqueCanonical(input.workerAgents);

  if (input.requestedReviewer !== undefined) {
    const requested = canonicalAgentName(input.requestedReviewer.trim());
    if (reviewerKind(requested) === "auxiliary") return { status: "unavailable", reason: "requested_reviewer_is_auxiliary" };
    if (!candidates.includes(requested)) return { status: "unavailable", reason: "requested_reviewer_unavailable" };
    const sameAsSomeWorker = workers.some((worker) =>
      input.resolveModel !== undefined
        ? !heterogeneousByModel(worker, requested, input.resolveModel)
        : !isHeterogeneous(worker, requested),
    );
    const effectiveMode = sameAsSomeWorker ? "self" : "hetero";
    return { status: "selected", reviewers: [candidateRecord(requested, effectiveMode, false)] };
  }

  if (input.candidates.length === 0) return { status: "unavailable", reason: "no_installed_reviewer" };
  if (candidates.length === 0) return { status: "unavailable", reason: "no_external_reviewer" };

  if (input.mode === "self") {
    const reviewers = selfReviewers(candidates, input.workerAgents);
    if (reviewers.length === 0) return { status: "unavailable", reason: "no_external_reviewer" };
    return { status: "selected", reviewers: reviewers.map((agent) => candidateRecord(agent, "self", false)) };
  }

  // FIX-312 — `auto` is hetero-FIRST. Rank all heterogeneous candidates before any
  // self path, and include a same-vendor fallback only when auto mode permits it.
  const hetero = candidates.filter((agent) => isHeterogeneousFromWorkers(agent, workers, input.resolveModel));

  if (input.mode === "hetero") {
    if (hetero.length === 0) return { status: "unavailable", reason: "no_heterogeneous_reviewer" };
    return { status: "selected", reviewers: hetero.map((agent) => candidateRecord(agent, "hetero", false)) };
  }

  const selfPool = selfReviewers(
    candidates.filter((agent) => !isHeterogeneousFromWorkers(agent, workers, input.resolveModel)),
    workers,
  );

  if (hetero.length === 0) {
    if (selfPool.length === 0) return { status: "unavailable", reason: "no_external_reviewer" };
    return { status: "selected", reviewers: selfPool.map((agent) => candidateRecord(agent, "self", true, "single_provider_available")) };
  }

  return {
    status: "selected",
    reviewers: [
      ...hetero.map((agent) => candidateRecord(agent, "hetero", false)),
      ...selfPool.map((agent) => candidateRecord(agent, "self", true, "all_heterogeneous_peers_failed")),
    ],
  };
}

/** Backward-compatible single-reviewer selector: returns the head of the ranked list. */
export function selectPeerReviewer(input: PeerReviewerInput): PeerReviewerSelection {
  const selected = selectPeerReviewers(input);
  if (selected.status === "unavailable") return selected;
  const first = selected.reviewers[0];
  if (first === undefined) return { status: "unavailable", reason: "no_external_reviewer" };
  return { status: "selected", ...first };
}

/** Spawn result for one candidate inside {@link runPeerReviewerRotation}. */
export interface PeerReviewerSpawnResult {
  status: "ok" | "timeout" | "error";
  stdout: string;
  reason?: string;
}

/** Spawn callback for {@link runPeerReviewerRotation}; receives one ranked candidate. */
export type PeerReviewerSpawnFn = (candidate: PeerReviewerCandidate) => Promise<PeerReviewerSpawnResult>;

export interface PeerReviewerRotationResult {
  candidate: PeerReviewerCandidate;
  result: PeerReviewerSpawnResult;
  attempts: Array<{ candidate: PeerReviewerCandidate; result: PeerReviewerSpawnResult }>;
}

/**
 * FIX-336 shared primitive: iterate the ranked heterogeneous candidate list,
 * stopping on the first successful spawn. Returns the ok candidate+result, or the
 * last failure if every candidate failed (timeout/error). Undefined only when the
 * input list is empty.
 */
export async function runPeerReviewerRotation(
  candidates: PeerReviewerCandidate[],
  spawnFn: PeerReviewerSpawnFn,
): Promise<PeerReviewerRotationResult | undefined> {
  const attempts: Array<{ candidate: PeerReviewerCandidate; result: PeerReviewerSpawnResult }> = [];
  for (const candidate of candidates) {
    const result = await spawnFn(candidate);
    attempts.push({ candidate, result });
    if (result.status === "ok") return { candidate, result, attempts };
  }
  const last = attempts[attempts.length - 1];
  return last === undefined ? undefined : { candidate: last.candidate, result: last.result, attempts };
}

export function parsePeerReviewTranscript(stdout: string): ParsedPeerReview {
  const verdicts = [...stdout.matchAll(/^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES)\s*$/gim)].map((m) =>
    (m[1] ?? "").toUpperCase(),
  );
  const findings = reviewFindings(stdout);
  if (verdicts.length !== 1) {
    const reason = reviewReason(stdout, "");
    return {
      verdict: "REQUEST_CHANGES",
      reason: "malformed_or_multiple_verdict_lines",
      findings: findings.length > 0 || reason === "" ? findings : [reason],
    };
  }
  const verdict = verdicts[0] === "APPROVE" ? "APPROVE" : "REQUEST_CHANGES";
  return {
    verdict,
    reason: reviewReason(stdout, verdict === "APPROVE" ? "approved" : "review_requested_changes"),
    findings,
  };
}

export function reviewFindings(stdout: string): string[] {
  const explicit = [...stdout.matchAll(/^\s*FINDING:\s*(.+)$/gim)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
  if (explicit.length > 0) return explicit.slice(0, 10);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^VERDICT:/i.test(line) && !/^REASON:/i.test(line))
    .slice(0, 5);
}

export function reviewReason(stdout: string, fallback: string): string {
  const explicit = /^\s*REASON:\s*(.+)$/im.exec(stdout)?.[1]?.trim();
  if (explicit !== undefined && explicit !== "") return explicit.slice(0, 500);
  return reviewFindings(stdout)[0]?.slice(0, 500) ?? fallback;
}

// ── FIX-1491: the "is this output an acceptable review?" decision, made pure ───

export type PeerReviewParse =
  | { readonly ok: true; readonly verdict: "agree" | "refine" | "object"; readonly findings: readonly string[] }
  | { readonly ok: false; readonly reason: "no_verdict_line" };

/**
 * FIX-1491 — decide whether a peer's raw stdout constitutes a real review.
 *
 * The invariant this makes testable: **a peer that did not clearly state a verdict
 * produces NO review at all.** It must never fall back to `agree` — an empty or
 * truncated response (a broken credential, a killed process, a model that ignored
 * the protocol) would then be recorded as "reviewed, nothing wrong found", which is
 * a fabricated green light on someone else's code.
 *
 * The investigation behind FIX-1491 expected to FIND that bug. It is not there —
 * the review path already refuses on all three failure modes (timeout, non-zero
 * exit, missing VERDICT). Extracting the decision here is what stops it from being
 * introduced later by someone "helpfully" defaulting the verdict.
 */
export function parsePeerReviewOutput(stdout: string): PeerReviewParse {
  const vm = /VERDICT:\s*(agree|refine|object)/i.exec(stdout);
  if (vm === null) return { ok: false, reason: "no_verdict_line" };
  const verdict = (vm[1] ?? "").toLowerCase() as "agree" | "refine" | "object";
  const findings = [...stdout.matchAll(/^\s*FINDING:\s*(.+)$/gim)].map((m) => (m[1] ?? "").trim());
  return { ok: true, verdict, findings };
}
