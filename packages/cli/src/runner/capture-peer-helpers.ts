import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  authCooldownExclusions,
  canonicalAgentName,
  excludedPeers,
  parsePeerReviewOutput,
  peerRunIdentity,
  type CycleContext,
} from "@roll/core";
import { configuredPeerModel } from "./node-ports.js";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { classifyBlockSignature } from "./agent-liveness.js";
import { blockIfAgentCredentialsMissing } from "./agent-routing.js";
import { buildReviewPrompt, type PairReview } from "./pairing-gate.js";
import { resolveExecutionCwd } from "./submodule-worktree.js";
import { spawnWatched } from "./spawn-watchdog.js";
import type { Ports } from "./ports.js";
import { eventTs } from "./runner-time.js";

const execFileAsync = promisify(execFile);

type BlockCause = "auth" | "network";
type PeerStage = "review" | "score";

export function createCapturePeerHelpers(params: {
  ports: Ports;
  ctx: CycleContext;
  commitsAhead: number;
  tcrCount: number;
}): {
  attributeBlockCause: (
    peer: string,
    outcome: "timeout" | "error",
    rawOutput: string,
    stage: PeerStage,
  ) => Promise<BlockCause | null>;
  savePeerRawOutput: (peer: string, stage: PeerStage, stdout: string, stderr: string) => string;
  peerAvailable: (agent: string) => boolean;
  reviewPeer: (peer: string, diff: string, timeoutMs: number) => Promise<PairReview | null>;
  cycleDiff: (cwd: string) => Promise<string>;
} {
  const { ports, ctx, commitsAhead, tcrCount } = params;
  // FIX-363: attribute a reviewer/scorer failure to its CAUSE. Signature-match
  // the output we ALREADY have (zero cost); only a SILENT timeout (no output,
  // no signature) spends ONE cheap reachability probe to tell a blocked agent
  // from a slow one. On a definite external block (auth/network) emit
  // `agent:blocked` so loop-run-once isolates it from the code-failure counter
  // and raises an actionable "re-login / check VPN" pause instead of a phantom
  // code-bug hint. Heuristic by design — it only nudges a counter + an alert,
  // never drops a real delivery, so a false positive is at worst a wrong hint.
  const attributeBlockCause = async (
    peer: string,
    outcome: "timeout" | "error",
    rawOutput: string,
    stage: PeerStage,
  ): Promise<BlockCause | null> => {
    const initialCause = classifyBlockSignature(rawOutput);
    let cause: BlockCause | null = initialCause === "auth" || initialCause === "network" ? initialCause : null;
    if (cause === null && outcome === "timeout" && ports.agentReachable !== undefined) {
      try {
        const reach = await ports.agentReachable(peer);
        if (!reach.reachable && (reach.cause === "auth" || reach.cause === "network")) cause = reach.cause;
      } catch {
        /* the probe is best-effort — it must never topple the cycle */
      }
    }
    if (cause === "auth" || cause === "network") {
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "agent:blocked",
        cycleId: ctx.cycleId ?? "",
        agent: peer,
        cause,
        stage,
        detail: (rawOutput.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 200),
        ts: eventTs(ports),
      });
    }
    return cause;
  };
  const rawArtifactAttempts = new Map<string, number>();
  const savePeerRawOutput = (peer: string, stage: PeerStage, stdout: string, stderr: string): string => {
    const key = `${peer}:${stage}`;
    const attempt = (rawArtifactAttempts.get(key) ?? 0) + 1;
    rawArtifactAttempts.set(key, attempt);
    const peerDir = join(dirname(ports.paths.eventsPath), "cycle-logs", ctx.cycleId ?? "cycle", "peer");
    mkdirSync(peerDir, { recursive: true });
    const artifactPath = join(peerDir, `${peer}.${stage}.attempt-${attempt}.raw.txt`);
    writeFileSync(artifactPath, `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
    return artifactPath;
  };
  // FIX-1056: enter cooldown ONLY after a genuine same-envelope auth-failure
  // streak reaches threshold ({@link authCooldownExclusions}) — a guardrail
  // against re-prompting a genuinely auth-blocked peer every cycle, NOT the
  // primary fix (that is agy's auth-context envelope in agent-spawn.ts). The
  // streak resets on ANY later success and `network` blocks never count, so a
  // once-blocked-then-re-authenticated peer recovers automatically. Each newly
  // cooled-down peer emits a VISIBLE `pair:excluded` (agent + cause auth +
  // failure count) so the owner sees WHY it stopped being consulted; the next
  // eligible candidate is swapped in by peerAvailable below. `excludedPeers`
  // stays the V4 fair no-op — only a live auth streak benches a peer.
  const computeAuthDiagnostics = (): Set<string> => {
    try {
      if (!existsSync(ports.paths.eventsPath)) return excludedPeers([]);
      const events = readFileSync(ports.paths.eventsPath, "utf8")
        .split("\n")
        .map(parseEventLine)
        .filter((e): e is RollEvent => e !== null);
      const cooldown = authCooldownExclusions(events);
      for (const [peer, failures] of cooldown) {
        ports.events.appendEvent(ports.paths.eventsPath, {
          type: "pair:excluded",
          cycleId: ctx.cycleId ?? "",
          agent: peer,
          cause: "auth",
          failures,
          ts: eventTs(ports),
        });
      }
      return new Set(cooldown.keys());
    } catch {
      return excludedPeers([]);
    }
  };
  const peerAvailable = (() => {
    const excluded = computeAuthDiagnostics();
    return (agent: string): boolean => !excluded.has(canonicalAgentName(agent));
  })();
  // The one-way peer-consult closure, shared by the peer gate's retry
  // (FIX-293) and the opt-in pairing stages (US-PAIR-003). A different agent
  // reads the cycle diff and returns a terse verdict; 30s hard timeout
  // (belt-and-braces race) so a flaky peer (pi) never stalls the cycle.
  const reviewPeer = async (peer: string, diff: string, timeoutMs: number): Promise<PairReview | null> => {
    // FIX-319: a REVIEW-ONLY prompt. The spawn is `bare` (no worker autorun
    // directive), so the reviewer is framed solely by this — it is NOT told to
    // "complete the delivery / don't just summarize / do the work", which made
    // reviewers try to deliver (and risk mutating the worktree) instead of
    // returning a terse verdict.
    // FIX-387: enrich with build/TCR status + main-baseline context so the
    // reviewer does NOT mistake imports of main-defined symbols as build regressions.
    const prompt = buildReviewPrompt({
      diff,
      commitsAhead,
      tcrCount,
    });
    // FIX-319: record EVERY consult's real wall-clock + outcome (pair:consult)
    // so the 120s hard timeout can be tuned from data, not guessed.
    const t0 = Date.now();
    const emitConsult = (
      outcome: "reviewed" | "timeout" | "error",
      cause?: BlockCause,
      detail?: string,
      artifactPath?: string,
    ): void =>
      ports.events.appendEvent(ports.paths.eventsPath, {
        type: "pair:consult",
        cycleId: ctx.cycleId ?? "",
        peer,
        durationMs: Date.now() - t0,
        outcome,
        ...(cause !== undefined ? { cause } : {}),
        ...(detail !== undefined ? { detail: detail.slice(0, 200) } : {}),
        ...(artifactPath !== undefined ? { artifactPath } : {}),
        ts: eventTs(ports),
      });
    let res;
    // US-PAIR-011: the CONFIGURED model for this peer — rig-declared if agents.yaml
    // pins one, else the agent's registered default. Resolved BEFORE the spawn so
    // selection never depends on post-hoc observation (several agents have stub
    // usage extractors and would be permanently undeterminable).
    const reviewModel = configuredPeerModel(ports.repoCwd, peer);
    const credentialBlock = blockIfAgentCredentialsMissing(peer, "review", ports, ctx);
    if (credentialBlock !== null) {
      emitConsult("error", "auth", credentialBlock);
      return null;
    }
    try {
      // Belt-and-braces hard timeout: race the spawn against a wall clock so
      // the cap is enforced even if an agent's spawn path ignores its own
      // timeoutMs. Whichever loses, the cycle is never stalled.
      // E4: the reviewer inspects the committed delivery, so it runs in the
      // execution worktree (submodule cycle worktree for a submodule story).
      const reviewCwd = resolveExecutionCwd(ports, ctx);
      // US-CYCLE-002: the peer-review sub-spawn is watchdog-wrapped (evaluator
      // role) for uniform accounting + no bypass; its own short `timeoutMs` race
      // stays the primary cap for this quick read-only consult.
      res = await Promise.race([
        spawnWatched({
          ports,
          ctx,
          purpose: "peer",
          agent: peer,
          observeCwd: reviewCwd,
          run: () =>
            ports.agentSpawn(peer, {
              cwd: reviewCwd,
              skillBody: prompt,
              timeoutMs,
              bare: true, // FIX-319: review-only framing, no worker autorun directive
              // US-PAIR-011: pin the CONFIGURED model. Without this the reviewer ran
              // whatever its CLI defaulted to (cursor defaults to `auto`), so any
              // isolation claim about "which model reviewed this" was unfounded.
              ...(reviewModel !== "" ? { model: reviewModel } : {}),
              ...(ctx.evidenceRunDir !== undefined ? { runDir: ctx.evidenceRunDir } : {}),
            }),
        }).then((r) => r.result),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
      ]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const cause = await attributeBlockCause(peer, "error", detail, "review");
      emitConsult("error", cause ?? undefined, detail);
      return null;
    }
    if (res === null || res.timedOut) {
      // FIX-363: a "timeout" is not always slowness. Attribute it — a silent
      // hang with no output spends ONE cheap reachability probe to tell a
      // blocked agent (re-login / VPN) from a genuinely slow one.
      const raw = res !== null ? `${res.stdout}\n${res.stderr}` : "";
      const artifactPath = res !== null ? savePeerRawOutput(peer, "review", res.stdout, res.stderr) : undefined;
      const cause = await attributeBlockCause(peer, "timeout", raw, "review");
      emitConsult("timeout", cause ?? undefined, artifactPath !== undefined ? "timeout; raw output saved" : "timeout", artifactPath);
      return null;
    }
    if (res.exitCode !== 0) {
      const raw = `${res.stdout}\n${res.stderr}`;
      const artifactPath = savePeerRawOutput(peer, "review", res.stdout, res.stderr);
      const cause = await attributeBlockCause(peer, "error", raw, "review");
      emitConsult("error", cause ?? undefined, `exit code ${res.exitCode}; raw output saved`, artifactPath);
      return null;
    }
    // FIX-1491: the accept/refuse decision is a pure function so the invariant
    // "no clear verdict ⇒ NO review" is pinned by a test and cannot be softened
    // into a default `agree` later.
    const parsed = parsePeerReviewOutput(res.stdout);
    if (!parsed.ok) {
      const artifactPath = savePeerRawOutput(peer, "review", res.stdout, res.stderr);
      emitConsult("error", undefined, "unparseable: missing or invalid VERDICT line", artifactPath);
      return null;
    }
    const { verdict } = parsed;
    const findings = [...parsed.findings];
    // US-PAIR-006 cost observability (owner's top priority "至少知道花了多少钱"):
    // the pair:verdict cost is now the peer's REAL list cost, parsed from its
    // own stdout (claude stream-json or the per-agent stdout-scrape extractors).
    // Best-effort by contract — an unparseable peer records 0, never throws.
    // US-PAIR-014: carry the BASIS, not just the number — an unparseable peer is
    // "unobservable", which must never be rendered as "$0.00 / free".
    emitConsult("reviewed");
    // US-PAIR-011: `model` is what config pinned (selection identity);
    // `observedModel` is what the peer's own usage footer claimed, when it claimed
    // anything — reconciliation only (US-PAIR-018), never an input to selection.
    return { verdict, findings, ...peerRunIdentity(peer, res.stdout, reviewModel) };
  };
  // Full cycle diff (origin/main...HEAD), shared by the gate retry + pairing.
  const cycleDiff = async (cwd: string): Promise<string> => {
    try {
      // Baseline mirrors peer-gate's cycleChangedFiles (origin/main...HEAD):
      // roll's loop always targets main (Done ≡ merged to main), so this is
      // the cycle's net change. Kept identical to peer-gate for consistency.
      const { stdout } = await execFileAsync("git", ["diff", "origin/main...HEAD"], { cwd, encoding: "utf8" });
      return stdout.slice(0, 60_000);
    } catch {
      return "";
    }
  };
  return { attributeBlockCause, savePeerRawOutput, peerAvailable, reviewPeer, cycleDiff };
}
