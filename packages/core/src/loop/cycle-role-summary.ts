/**
 * @responsibility Projects one cycle's event stream into a readable role chain.
 * CycleRoleSummary — US-OBS-032: a pure projection that reads the RollEvent
 * stream for one cycle and translates low-level events into a readable role
 * chain: Builder, Peer Reviewer, Evaluator, and Attest Gate.
 *
 * This is a projection over existing truth (events.ndjson + peer artifacts),
 * NOT a new source of truth. It is idempotent: rebuilding the same summary
 * from the same facts yields byte-stable output.
 */
import {
  type RollEvent,
  type CycleRoleAttempt,
  type CycleRoleName,
  type CycleRoleAttemptState,
  type CycleRoleSummary,
  type ExecutionProfile,
} from "@roll/spec";

// ── Public API ──────────────────────────────────────────────────────────────

export interface BuildCycleRoleSummaryInput {
  readonly cycleId: string;
  readonly events: readonly RollEvent[];
  readonly eventsPath?: string;
  readonly peerDir: string;
  readonly cycleLogDir: string;
  readonly deliveries?: readonly DeliveryRecord[];
}

export interface DeliveryRecord {
  readonly prNumber?: number;
  readonly mergeCommit?: string;
  readonly mergedAt?: string;
}

/**
 * Build a CycleRoleSummary from the event stream for one cycle.
 * Idempotent: same facts in → same summary out.
 */
export function buildCycleRoleSummary(input: BuildCycleRoleSummaryInput): CycleRoleSummary {
  const { cycleId, events, peerDir, cycleLogDir, deliveries } = input;
  const cycleEvents = events.filter((e) => "cycleId" in e && (e as { cycleId: string }).cycleId === cycleId);
  const roles: CycleRoleAttempt[] = [];
  let storyId = "";
  let executionProfile: ExecutionProfile = "standard";
  let builderSessionId: string | undefined;
  const sources: string[] = [];
  addSource(sources, input.eventsPath);
  addSource(sources, cycleLogDir);
  const peerArtifactPath = artifactPath(peerDir, cycleId, "review");
  const scoreArtifactPath = artifactPath(peerDir, cycleId, "score");

  // Builder: from cycle:start
  const startEvent = cycleEvents.find((e) => e.type === "cycle:start") as
    | { type: "cycle:start"; cycleId: string; storyId: string; agent: string; model: string; ts: number }
    | undefined;
  if (startEvent) {
    storyId = startEvent.storyId;
    if (startEvent.agent) {
      const builderLog = `${cycleLogDir}/${cycleId}.agent.log`;
      roles.push({
        role: "builder",
        agent: startEvent.agent,
        model: startEvent.model || undefined,
        state: "accepted" as CycleRoleAttemptState,
        stage: "build",
        acceptedByGate: false,
        ts: startEvent.ts,
        logPath: builderLog,
      });
      addSource(sources, builderLog);
    }
  }

  // Execution profile
  const profileEvent = cycleEvents.find((e) => e.type === "execution:profile") as
    | { type: "execution:profile"; profile: ExecutionProfile }
    | undefined;
  if (profileEvent) {
    executionProfile = profileEvent.profile;
  }

  // Pair events: peer reviewers and scorers
  const selectedReviewers = cycleEvents.filter(
    (e) => e.type === "pair:selected" && isPeerReviewStage((e as { stage?: string }).stage),
  ) as Array<{ type: "pair:selected"; cycleId: string; workingAgent: string; peer: string; stage: string; ts: number }>;

  const selectedScorers = cycleEvents.filter(
    (e) => e.type === "pair:selected" && (e as { stage?: string }).stage === "score",
  ) as Array<{ type: "pair:selected"; cycleId: string; workingAgent: string; peer: string; stage: string; ts: number }>;

  const verdicts = cycleEvents.filter((e) => e.type === "pair:verdict") as Array<{
    type: "pair:verdict";
    cycleId: string;
    peer: string;
    verdict: string;
    findings: number;
    stage?: string;
    ts: number;
  }>;

  const scores = cycleEvents.filter((e) => e.type === "pair:score") as Array<{
    type: "pair:score";
    cycleId: string;
    peer: string;
    score: number;
    verdict: string;
    stage: string;
    ts: number;
  }>;

  const scoreFailures = cycleEvents.filter((e) => e.type === "pair:score-failure") as Array<{
    type: "pair:score-failure";
    cycleId: string;
    peer: string;
    cause: string;
    detail?: string;
    artifactPath?: string;
    stage: string;
    ts: number;
  }>;

  const consults = cycleEvents.filter((e) => e.type === "pair:consult") as Array<{
    type: "pair:consult";
    cycleId: string;
    peer: string;
    outcome: string;
    cause?: string;
    detail?: string;
    artifactPath?: string;
    ts: number;
  }>;

  const blocks = cycleEvents.filter((e) => e.type === "agent:blocked") as Array<{
    type: "agent:blocked";
    cycleId: string;
    agent: string;
    cause: string;
    stage: string;
    detail: string;
    ts: number;
  }>;

  const noneAvailable = cycleEvents.filter((e) => e.type === "pair:none-available") as Array<{
    type: "pair:none-available";
    cycleId: string;
    stage: string;
    ts: number;
  }>;

  // FIX-1054: candidates the serial dispatch SKIPPED after accepting a
  // reviewer/evaluator — recorded as a policy decision so cost/cycle views show
  // them AS skipped, not as zero-cost attempted peers.
  const skippedEvents = cycleEvents.filter((e) => e.type === "pair:skipped") as Array<{
    type: "pair:skipped";
    cycleId: string;
    peers: string[];
    reason: string;
    stage: string;
    ts: number;
  }>;

  // Peer Reviewers
  for (const sel of selectedReviewers) {
    const peer = sel.peer;
    addSource(sources, peerArtifactPath);
    const verdict = verdicts.find((v) => v.peer === peer && isPeerReviewStage(v.stage ?? sel.stage));
    const consult = consults.find((c) => c.peer === peer);
    const block = blocks.find((b) => b.agent === peer && b.stage === "review");

    if (block) {
      roles.push({
        role: "peer_reviewer",
        agent: peer,
        stage: "review",
        state: "failed",
        cause: block.cause,
        detail: block.detail,
        artifactPath: peerArtifactPath,
        acceptedByGate: false,
        ts: block.ts,
      });
    } else if (verdict) {
      const peerGate = cycleEvents.find((e) => e.type === "peer:gate") as
        | { type: "peer:gate"; cycleId: string; verdict: string }
        | undefined;
      const accepted = peerGate !== undefined && peerGate.verdict === "consulted";
      roles.push({
        role: "peer_reviewer",
        agent: peer,
        stage: "review",
        state: accepted ? "accepted" : "returned",
        verdict: verdict.verdict,
        findings: verdict.findings,
        artifactPath: peerArtifactPath,
        acceptedByGate: accepted,
        ts: verdict.ts,
      });
    } else if (consult) {
      if (consult.outcome !== "reviewed") {
        roles.push({
          role: "peer_reviewer",
          agent: peer,
          stage: "review",
          state: "failed",
          cause: consult.cause ?? (consult.detail?.startsWith("unparseable") === true ? "unparseable" : consult.outcome),
          detail: consult.detail,
          artifactPath: consult.artifactPath ?? peerArtifactPath,
          acceptedByGate: false,
          ts: consult.ts,
        });
        continue;
      }
      // Returned but no structured verdict — always "returned", never "accepted"
      // (only pair:verdict produces "accepted" per the plan's mapping rules).
      roles.push({
        role: "peer_reviewer",
        agent: peer,
        stage: "review",
        state: "returned",
        detail: consult.detail ?? "reviewed, no structured verdict accepted",
        artifactPath: consult.artifactPath ?? peerArtifactPath,
        acceptedByGate: false,
        ts: consult.ts,
      });
    } else {
      roles.push({
        role: "peer_reviewer",
        agent: peer,
        stage: "review",
        state: "selected",
        artifactPath: peerArtifactPath,
        acceptedByGate: false,
        ts: sel.ts,
      });
    }
  }

  // Evaluators / Scorers
  for (const sel of selectedScorers) {
    const peer = sel.peer;
    addSource(sources, scoreArtifactPath);
    const nextSelectionTs = selectedScorers.find((candidate) => candidate.peer === peer && candidate.ts > sel.ts)?.ts ?? Number.POSITIVE_INFINITY;
    const attemptEvents = [
      ...blocks
        .filter((b) => b.agent === peer && b.stage === "score" && b.ts >= sel.ts && b.ts < nextSelectionTs)
        .map((block) => ({
          kind: "block" as const,
          ts: block.ts,
          cause: block.cause,
          detail: block.detail,
        })),
      ...scoreFailures
        .filter((f) => f.peer === peer && f.ts >= sel.ts && f.ts < nextSelectionTs)
        .map((failure) => ({
          kind: "failure" as const,
          ts: failure.ts,
          cause: failure.cause,
          detail: failure.detail,
          artifactPath: failure.artifactPath,
        })),
      ...scores
        .filter((s) => s.peer === peer && s.ts >= sel.ts && s.ts < nextSelectionTs)
        .map((score) => ({
          kind: "score" as const,
          ts: score.ts,
          score: score.score,
          verdict: score.verdict,
        })),
    ].sort((a, b) => a.ts - b.ts);

    if (attemptEvents.length === 0) {
      roles.push({
        role: "evaluator",
        agent: peer,
        stage: "score",
        state: "selected",
        artifactPath: scoreArtifactPath,
        acceptedByGate: false,
        ts: sel.ts,
      });
      continue;
    }

    for (const event of attemptEvents) {
      if (event.kind === "score") {
        const attestGate = cycleEvents.find((e) => e.type === "attest:gate") as
          | { type: "attest:gate"; cycleId: string; verdict: string }
          | undefined;
        const acceptedByGate = attestGate !== undefined && attestGate.verdict === "produced";
        roles.push({
          role: "evaluator",
          agent: peer,
          stage: "score",
          state: "accepted",
          score: event.score,
          verdict: event.verdict,
          artifactPath: scoreArtifactPath,
          acceptedByGate,
          ts: event.ts,
        });
      } else {
        const failureArtifactPath = "artifactPath" in event ? (event as { artifactPath?: string }).artifactPath : undefined;
        roles.push({
          role: "evaluator",
          agent: peer,
          stage: "score",
          state: "failed",
          cause: event.cause,
          detail: event.detail,
          artifactPath: failureArtifactPath ?? scoreArtifactPath,
          acceptedByGate: false,
          ts: event.ts,
        });
      }
    }
  }

  // Scorers with score-failure but no pair:selected (e.g. agy in the worked sample)
  for (const fail of scoreFailures) {
    const alreadyHandled = roles.some(
      (r) => r.role === "evaluator" && r.agent === fail.peer,
    );
    if (!alreadyHandled) {
      addSource(sources, scoreArtifactPath);
      roles.push({
        role: "evaluator",
        agent: fail.peer,
        stage: "score",
        state: "failed",
        cause: fail.cause,
        detail: fail.detail,
        artifactPath: fail.artifactPath ?? scoreArtifactPath,
        acceptedByGate: false,
        ts: fail.ts,
      });
    }
  }

  // `pair:none-available` — no scorer was available
  if (noneAvailable.length > 0) {
    for (const na of noneAvailable) {
      roles.push({
        role: na.stage === "score" ? ("evaluator" as CycleRoleName) : ("peer_reviewer" as CycleRoleName),
        agent: null,
        stage: na.stage === "score" ? "score" : "review",
        state: "not_available",
        acceptedByGate: false,
        ts: na.ts,
      });
    }
  }

  // FIX-1054: skipped-by-policy candidates → one role attempt per skipped peer,
  // stamped `skipped`, so the operator sees they were deliberately NOT spent (a
  // cost decision), distinct from peers that failed or were never available.
  for (const skip of skippedEvents) {
    const isScore = skip.stage === "score" || skip.stage === "design";
    for (const peer of skip.peers) {
      // Don't double-count a peer that was actually spawned in this cycle.
      const alreadySpawned = roles.some(
        (r) => r.agent === peer && ((isScore && r.role === "evaluator") || (!isScore && r.role === "peer_reviewer")),
      );
      if (alreadySpawned) continue;
      roles.push({
        role: isScore ? "evaluator" : "peer_reviewer",
        agent: peer,
        stage: isScore ? "score" : "review",
        state: "skipped",
        detail: skip.reason,
        acceptedByGate: false,
        ts: skip.ts,
      });
    }
  }

  if (startEvent && !roles.some((r) => r.role === "peer_reviewer")) {
    roles.push({
      role: "peer_reviewer",
      agent: null,
      stage: "review",
      state: "not_required",
      acceptedByGate: false,
      ts: startEvent?.ts ?? 0,
    });
  }

  if (startEvent && !roles.some((r) => r.role === "evaluator")) {
    roles.push({
      role: "evaluator",
      agent: null,
      stage: "score",
      state: executionProfile === "standard" ? "not_required" : "not_available",
      acceptedByGate: false,
      ts: startEvent?.ts ?? 0,
    });
  }

  // Attest Gate — only add if an actual attest:gate event exists
  const attestGateEvent = cycleEvents.find((e) => e.type === "attest:gate") as
    | { type: "attest:gate"; cycleId: string; verdict: string; reasons?: string[]; ts: number }
    | undefined;

  if (attestGateEvent) {
    roles.push({
      role: "attest_gate",
      agent: null,
      stage: "attest",
      state: attestGateEvent.verdict === "produced" ? "accepted" : "rejected",
      verdict: attestGateEvent.verdict,
      detail: attestGateEvent.reasons?.join("; "),
      acceptedByGate: false,
      ts: attestGateEvent.ts,
    });
  }
  const attestVerdict = attestGateEvent?.verdict ?? undefined;

  // Gates summary
  const peerGateEvent = cycleEvents.find((e) => e.type === "peer:gate") as
    | { type: "peer:gate"; cycleId: string; verdict: string }
    | undefined;

  // Delivery facts from external records
  let deliveryStatus: string | undefined;
  if (deliveries && deliveries.length > 0) {
    const merged = deliveries.find((d) => d.mergeCommit);
    if (merged) {
      deliveryStatus = merged.prNumber ? `PR #${merged.prNumber} merged` : "merged";
    } else {
      deliveryStatus = `PR #${deliveries[0]!.prNumber ?? "?"} open`;
    }
  } else {
    // Check for cycle:end outcome
    const endEvent = cycleEvents.find((e) => e.type === "cycle:end") as
      | { type: "cycle:end"; cycleId: string; outcome: string }
      | undefined;
    if (endEvent) {
      deliveryStatus = endEvent.outcome;
    }
  }

  return {
    schema: "cycle-role-summary.v1",
    cycleId,
    storyId: storyId || "unknown",
    executionProfile,
    generatedAt: generatedAtFromEvents(cycleEvents),
    builderSessionId,
    roles,
    gates: {
      peerGate: peerGateEvent?.verdict,
      attestGate: attestVerdict,
      delivery: deliveryStatus,
    },
    sources,
  };
}

// ── Markdown rendering ───────────────────────────────────────────────────────

/**
 * Render a CycleRoleSummary to human-readable markdown.
 * Matches the worked-sample shape from the plan.
 */
export function renderCycleRoleSummaryMarkdown(summary: CycleRoleSummary): string {
  const lines: string[] = [];
  lines.push(`# Cycle Role Summary — ${summary.cycleId}`);
  lines.push("");
  lines.push(`Story: ${summary.storyId}`);
  lines.push(`Execution profile: ${summary.executionProfile}`);
  if (summary.builderSessionId) lines.push(`Builder session: ${summary.builderSessionId}`);
  lines.push("");

  // Group roles by type
  const byRole = groupBy(summary.roles, (r) => r.role);

  // Builder
  const builders = byRole.get("builder") ?? [];
  if (builders.length > 0) {
    lines.push("## Builder");
    for (const b of builders) {
      const agent = b.agent ?? "unknown";
      const model = b.model ? ` / ${b.model}` : "";
      lines.push(`- ${agent}${model}`);
      if (b.logPath) lines.push(`  - log: ${b.logPath}`);
    }
    lines.push("");
  }

  // Peer Review
  const reviewers = byRole.get("peer_reviewer") ?? [];
  if (reviewers.length > 0) {
    lines.push("## Peer Review");
    for (const r of reviewers) {
      const agent = r.agent ?? "(none)";
      let detail = r.state;
      if (r.state === "accepted" && r.verdict) detail += ` verdict=${r.verdict}`;
      if (r.findings !== undefined) detail += ` findings=${r.findings}`;
      if (r.cause) detail += ` ${r.cause}`;
      if (r.detail) detail += ` (${r.detail})`;
      lines.push(`- ${agent}: ${detail}`);
      if (r.state === "failed" && r.artifactPath) {
        lines.push(`  - raw artifact: ${r.artifactPath}`);
      }
    }
    lines.push("");
  } else {
    lines.push("## Peer Review");
    lines.push("- (none)");
    lines.push("");
  }

  // Evaluator / Score
  const evaluators = byRole.get("evaluator") ?? [];
  if (evaluators.length > 0) {
    lines.push("## Evaluator / Score");
    for (const e of evaluators) {
      const agent = e.agent ?? "(none)";
      let detail = e.state;
      if (e.state === "accepted") {
        if (e.score !== undefined) detail += ` score=${e.score}`;
        if (e.verdict) detail += ` verdict=${e.verdict}`;
      }
      if (e.cause) detail += ` ${e.cause}`;
      if (e.detail) detail += ` (${e.detail})`;
      lines.push(`- ${agent}: ${detail}`);
      if (e.state === "failed" && e.artifactPath) {
        lines.push(`  - raw artifact: ${e.artifactPath}`);
      }
    }
    lines.push("");
  } else {
    lines.push("## Evaluator / Score");
    lines.push("- (none)");
    lines.push("");
  }

  // Gates
  lines.push("## Gates");
  if (summary.gates.peerGate) lines.push(`- peer: ${summary.gates.peerGate}`);
  if (summary.gates.attestGate) lines.push(`- attest: ${summary.gates.attestGate}`);
  if (summary.gates.delivery) lines.push(`- delivery: ${summary.gates.delivery}`);
  lines.push("");

  return lines.join("\n");
}

// ── Terminal rendering ───────────────────────────────────────────────────────

/**
 * Render a concise terminal-friendly role summary.
 */
export function renderCycleRolesForTerminal(
  summary: CycleRoleSummary,
  opts: { json: boolean },
): string {
  if (opts.json) {
    return JSON.stringify(summary, null, 2);
  }
  return renderCycleRoleSummaryMarkdown(summary);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupBy<T, K extends string | number | symbol>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function isPeerReviewStage(stage: string | undefined): boolean {
  return stage === undefined || stage === "review" || stage === "code";
}

function artifactPath(peerDir: string, cycleId: string, kind: "review" | "score"): string | undefined {
  if (!peerDir) return undefined;
  const suffix = kind === "score" ? ".score.pair.json" : ".pair.json";
  return `${peerDir}/cycle-${cycleId}${suffix}`;
}

function addSource(sources: string[], path: string | undefined): void {
  if (!path) return;
  if (sources.includes(path)) return;
  sources.push(path);
}

function generatedAtFromEvents(events: readonly RollEvent[]): string {
  const maxTs = events.reduce((latest, event) => {
    return Number.isFinite(event.ts) && event.ts > latest ? event.ts : latest;
  }, 0);
  return new Date(maxTs).toISOString();
}
