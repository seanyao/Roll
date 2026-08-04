import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_REPAIR_ROUNDS,
  EventBus,
  agentsInstalled,
  cycleActivityFromEvents,
  decideRepair,
  initialRepairState,
  pairingHistory,
  peerRunIdentity,
  type CapturedFacts,
  type CycleCommand,
  type CycleContext,
} from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { realAgentEnv } from "../commands/agent-list.js";
import { configuredPeerModel, peerHeteroAvailability } from "./node-ports.js";
import { cardArchiveDir } from "../lib/archive.js";
import { formatEvaluationContractForScorer, parseEvaluationContract } from "../lib/evaluation-contract.js";
import { applyEvaluationTierGate, recordEvaluatorPanelRound } from "./evaluation-tier-stage.js";
import { blockIfAgentCredentialsMissing, projectAllowedAgents } from "./agent-routing.js";
import { readAttestGateMode, runAttestGate, verificationReportHasContent } from "./attest-gate.js";
import {
  acMapPath,
  runAcMapSelfHeal,
  type DraftEvidence,
} from "./attest-remediation.js";
import { applyCorrectionAction } from "./correction-actuator.js";
import { runEvaluatorStage } from "./execution-profile.js";
import { checkMainDirty, readMainDirtyBaseline, readMainHeadBaseline } from "./main-checkout-guard.js";
import {
  buildPairScorePrompt,
  diagnosePairScoreOutput,
  enabledPairingStages,
  retryPeerConsult,
  runPairing,
  runScorePairing,
  type PairEvent,
  type PairScore,
} from "./pairing-gate.js";
import { cycleChangedFiles, peerEvidencePresent, readPeerGateMode, readPeerOnPoolTimeout, runPeerGate, type PeerGateResult } from "./peer-gate.js";
import { createCapturePeerHelpers } from "./capture-peer-helpers.js";
import type { ExecuteResult, Ports } from "./ports.js";
import { eventTs, guardRuntimeDir } from "./runner-time.js";
import { quarantineMainCheckoutForCycle } from "./sandbox-boundary.js";
import { agentWritableRoots, submoduleAgentWritableRoots } from "./worktree-bootstrap.js";
import { resolveExecutionCwd, resolveExecutionRepoCwd } from "./submodule-worktree.js";
import { spawnWatched } from "./spawn-watchdog.js";
import { resolveIntegrationBranch } from "@roll/infra";

const execFileAsync = promisify(execFile);

type CaptureFactsCommand = Extract<CycleCommand, { kind: "capture_facts" }>;

export async function executeCaptureFactsCommand(
  cmd: CaptureFactsCommand,
  ports: Ports,
  ctx: CycleContext,
): Promise<ExecuteResult> {
  void cmd;
      // E4: the agent built/committed inside the EXECUTION worktree (the submodule
      // cycle worktree when the story declared a target_submodule, else the
      // superproject worktree). Every git OBSERVATION of the agent's delivery
      // (commits/TCR/diff/status) and every AGENT spawn that inspects it (scorer,
      // reviewer, remediation) runs there. The persistent-`.roll` reads
      // (spec/evidence/attest — `ports.paths.worktreePath`, where the loop `.roll`
      // is symlinked) are deliberately NOT routed: the submodule subdir has no
      // `.roll`. No targetSubmodule ⇒ both equal today's paths (zero regression).
      const execCwd = resolveExecutionCwd(ports, ctx);
      const execRepoCwd = resolveExecutionRepoCwd(ports, ctx);
      // E8: observe commits/TCR against the EXECUTION repo's integration branch,
      // NOT the hardwired origin/main. A submodule cycle worktree is a detached
      // `worktree add --detach` off the submodule's integration branch and has NO
      // origin/main — the old `git rev-list origin/main..HEAD` fataled → the catch
      // collapsed to 0/undefined → the engine misjudged a real N-commit delivery
      // as a zero-output failure. The baseline MUST come from execRepoCwd (the
      // submodule's <super>/<sub> main checkout, on its working branch), never the
      // detached cycle worktree (whose currentBranchSync is undefined → falls back
      // to origin/main again). No targetSubmodule ⇒ resolveIntegrationBranch(repoCwd)
      // → origin/main default, byte-identical to the prior hardcode.
      const observeBase = resolveIntegrationBranch(execRepoCwd);
      await quarantineMainCheckoutForCycle(ports, ctx, "capture");
      const commitsAhead = await ports.git.commitsAhead(execCwd, observeBase);
      let mainAhead = 0;
      try {
        mainAhead = await ports.git.mainAhead(ports.repoCwd);
      } catch {
        /* drift probe is best-effort */
      }
      // FIX-1475: scope the ahead probe to THIS cycle, exactly like E10 scopes
      // the dirt probe below. Pre-existing ahead commits on the shared main
      // checkout are legitimate state (they are never reset now), so only a
      // HEAD that MOVED since the pre-spawn baseline counts as a leak. A
      // missing baseline (old cycle / first run) keeps the absolute count —
      // the prior behavior.
      if (mainAhead > 0) {
        const baselineHead = readMainHeadBaseline(guardRuntimeDir(ports), ctx.cycleId ?? "");
        if (baselineHead !== "") {
          let head = "";
          try {
            head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ports.repoCwd, encoding: "utf8" })).stdout.trim();
          } catch {
            head = "";
          }
          if (head !== "" && head === baselineHead) mainAhead = 0;
        }
      }
      // E10: symmetric completion of E7. The LIVE watchdog already diffs the
      // main checkout against a pre-spawn baseline so only dirt the BUILDER
      // introduced counts as a leak; this terminal capture did NOT — it reported
      // ABSOLUTE dirt. On a submodule super-repo (permanently dirty: gitlink
      // pointer drift, colleague WIP, untracked `wt-*/`) that made mainDirty
      // eternally true → boundary_violation → the cycle failed with leakedCommits:0
      // (the builder touched nothing). We now read the pre-spawn baseline the
      // pre-spawn quarantine persisted (quarantineMainCheckoutForCycle) and count
      // ONLY paths that appeared AFTER spawn. A missing baseline (old cycle / first
      // run) → empty set → newDirty == the full set → byte-identical to the prior
      // absolute-dirt behavior (clean-main projects have an empty baseline anyway,
      // so this is a strict zero-regression widening). The protection is intact: a
      // builder that truly writes a NEW main-checkout path still yields a non-empty
      // newDirty → mainDirty:true.
      const mainDirtyAll = await checkMainDirty(ports.repoCwd);
      const mainDirtyBaseline = new Set(readMainDirtyBaseline(guardRuntimeDir(ports), ctx.cycleId ?? ""));
      const mainDirtyFiles = mainDirtyAll.filter((path) => !mainDirtyBaseline.has(path));
      const mainDirty = mainDirtyFiles.length > 0;
      // FIX-208: count real `tcr:` commits while the worktree is still alive
      // (the done/cleanup path removes it before the runs row is written). Folded
      // into liveCtx so buildRunRow stops hardcoding 0. Best-effort → 0 on error.
      let tcrCount = 0;
      try {
        // FIX-1244: undefined = undeterminable (git error) → keep the legacy 0
        // on THIS path (the publish-path gates already treat 0 conservatively);
        // the timeout teardown's measure_worktree is where unknown stays unknown.
        tcrCount = (await ports.git.tcrCount(execCwd, observeBase)) ?? 0;
      } catch {
        /* count is best-effort; a git miss must not fail the cycle */
      }
      // FIX-1039: check whether the worktree has uncommitted/untracked files.
      // Best-effort → false on git error (the probe must never fail the cycle).
      let worktreeDirty = false;
      try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
          cwd: execCwd,
          encoding: "utf8",
        });
        worktreeDirty = stdout.trim() !== "";
      } catch {
        /* probe is best-effort */
      }
      const { attributeBlockCause, savePeerRawOutput, peerAvailable, reviewPeer, cycleDiff } = createCapturePeerHelpers({
        ports,
        ctx,
        commitsAhead,
        tcrCount,
      });
      // FIX-293 peer gate: agent-agnostic, runs in EVERY cycle's capture step.
      // High-complexity delivery (>3 files / cross-module / high-risk) WITHOUT
      // peer evidence → ALERT + `peer:gate` event AND, in the default HARD mode,
      // a BLOCK: the verdict is no longer discarded. On a block we RE-ATTEMPT the
      // peer consult ONCE (existing reviewPeer path, same 30s hard timeout — no
      // death-spiral on a flaky peer). If the retry produces evidence the gate
      // re-runs green and the cycle proceeds; if it still yields none the cycle
      // ends NOT-Done (peerBlocked → facts.agentExit=1, mirroring the attest gate)
      // and an escalation alert fires. `loop_safety.peer_gate: soft` in
      // policy.yaml keeps the legacy record-only behaviour for a migration window.
      const peerGateMode = readPeerGateMode(ports.repoCwd);
      const runtimeDir = dirname(ports.paths.eventsPath);
      const cycleIdStr = ctx.cycleId ?? "";
      // FIX-935: agents explicitly configured in `.roll/agents.yaml` are the
      // project-config allowlist. Scoring and pairing must not auto-enable
      // machine-detected agents outside this set (e.g. codex or claude).
      const peerGateAllowedAgents = projectAllowedAgents(ports.repoCwd);
      // US-CYCLE-008 — evaluation depth from the card's lint-validated risk_tier
      // (high → panel, low/legacy → serial default, missing-on-new-regime →
      // fail-loud). Read ONLY from the spec — see evaluation-tier-stage.ts.
      const tierInfo = applyEvaluationTierGate(ports, ctx, { commitsAhead, cycleId: cycleIdStr, now: () => eventTs(ports) });
      const evalFanout = tierInfo.fanout;
      // FIX-312: hetero-availability drives the gate (owner ruling: "hetero
      // available → must use it; self only when hetero is truly impossible").
      // Computed uniformly by vendor through the standard model (no per-agent
      // special-casing): is there ≥1 installed agent of a DIFFERENT vendor than
      // the builder? true ⇒ a self-reviewed substantive delivery is blocked;
      // false ⇒ self-review is an allowed recorded fallback (single-agent setups).
      const peerGateInstalled = ports.installedAgents?.() ?? agentsInstalled(realAgentEnv());
      const peerGateWorker = ctx.agent ?? "claude";
      // US-PAIR-015: model-aware — see peerHeteroAvailability.
      const peerHeteroAvailable = peerHeteroAvailability(ports.repoCwd, peerGateInstalled, peerGateWorker, peerGateAllowedAgents);
      const peerGateSinks = {
        alert: (m: string) => ports.events.appendAlert(ports.paths.alertsPath, m),
        event: (p: { cycleId: string; verdict: string; reasons: string[] }) =>
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "peer:gate",
            cycleId: p.cycleId,
            verdict: p.verdict as "consulted" | "skipped" | "self-review-allowed",
            reasons: p.reasons,
            ts: eventTs(ports),
          }),
      };
      const peerGateOpts = { heteroAvailable: peerHeteroAvailable };
      // FIX-362: the peer-gate EXECUTION moved to AFTER the pairing loop below. The
      // hetero pairing review (runPairing) is what WRITES the peer-evidence file the
      // gate reads (peerEvidencePresent), so the gate MUST run after it. Running it
      // here (before pairing) always saw no evidence yet → it wrongly blocked EVERY
      // high-complexity / cross-module delivery (e.g. a legit 16-file currency fix)
      // as `hetero_available_self_review_violation`, even though a genuine hetero
      // review ran moments later. The peerGate* setup vars above are consumed there.
      // US-PAIR-003 cross-agent pairing: a scoped `story.evaluate` binding enables
      // a heterogeneous one-way review. runPairing records timeout/error outcomes
      // without blocking the cycle.
      //
      // Runtime pairing has one live review stage: code. A scoped
      // `story.evaluate` binding enables it; legacy pairing.yaml stage lists are
      // migration-only input and cannot alter runtime triggering.
      {
        // US-PAIR-006: per-peer track record from the event stream drives the
        // ε-greedy hit-rate preference. Best-effort: an unreadable/absent events
        // file → no history → pure seeded round-robin (US-PAIR-001 behaviour).
        let pairHistory;
        try {
          if (existsSync(ports.paths.eventsPath)) {
            const events = readFileSync(ports.paths.eventsPath, "utf8")
              .split("\n")
              .map(parseEventLine)
              .filter((e): e is RollEvent => e !== null);
            pairHistory = pairingHistory(events);
          }
        } catch {
          /* history is best-effort — a read miss must not affect the cycle */
        }
        // US-PAIR-004: build the deps once, then run each enabled stage.
        const pairingDeps = {
          installed: ports.installedAgents?.() ?? agentsInstalled(realAgentEnv()),
          // Historical auth streaks are diagnostics only; current availability
          // is checked by the runtime attempt.
          isAvailable: peerAvailable,
          reviewPeer,
          ...(pairHistory !== undefined ? { history: pairHistory } : {}),
          changedFiles: cycleChangedFiles,
          diff: cycleDiff,
          event: (e: PairEvent) => ports.events.appendEvent(ports.paths.eventsPath, e as RollEvent),
          now: () => eventTs(ports),
          // FIX-935: respect project-config agent allowlist.
          allowedAgents: peerGateAllowedAgents,
          // US-CYCLE-008: high-tier → parallel review panel; else serial default.
          ...(evalFanout !== undefined ? { fanout: evalFanout } : {}),
        };
        // A missing scoped evaluator binding yields no live review stage.
        // US-CYCLE-008: a tier-blocked cycle dispatches NO evaluators (fail-loud).
        for (const stage of tierInfo.blocked ? [] : enabledPairingStages(ports.repoCwd)) {
          // E4: the pairing reviewer diffs + reviews the delivery in the execution
          // worktree (the submodule cycle worktree for a submodule story).
          await runPairing(ports.repoCwd, execCwd, dirname(ports.paths.eventsPath), ctx.cycleId ?? "", ctx.agent ?? "", stage, pairingDeps);
        }
      }
      // FIX-362: peer-gate runs HERE — AFTER the pairing review wrote its evidence
      // (.pair.json), so a genuinely hetero-reviewed delivery reads as `consulted`
      // and is NOT blocked. Without a scoped evaluator binding no evidence exists,
      // so the gate's own retryPeerConsult fallback runs (single-agent path, unchanged).
      // US-CYCLE-008: on a tier-blocked cycle the peer gate (and its retry consult,
      // which SPAWNS a peer) must not run. A non-blocking stub keeps peerBlocked=false.
      let peerGate: PeerGateResult = tierInfo.blocked
        ? { verdict: "skipped", mode: peerGateMode, reasons: ["eval_tier_unresolved: evaluate stage skipped"], blocked: false }
        : await runPeerGate(execCwd, runtimeDir, cycleIdStr, peerGateMode, peerGateSinks, peerGateOpts);
      let peerBlocked = peerGate.blocked;
      if (peerGate.blocked) {
        // AC-H3: bounded retry — exactly one re-attempt via the existing consult.
        const retryInstalled = peerGateInstalled.filter((a) => peerAvailable(a));
        const retry = await retryPeerConsult(execCwd, runtimeDir, cycleIdStr, {
          installed: retryInstalled.length > 0 ? retryInstalled : peerGateInstalled,
          workingAgent: peerGateWorker,
          reviewPeer,
          diff: cycleDiff,
          event: (e: PairEvent) => ports.events.appendEvent(ports.paths.eventsPath, e as RollEvent),
          now: () => eventTs(ports),
          // FIX-935: respect project-config agent allowlist.
          allowedAgents: peerGateAllowedAgents,
        });
        if (retry.status === "reviewed" && peerEvidencePresent(runtimeDir, cycleIdStr)) {
          // Retry produced evidence → re-run the gate; it now sees `consulted`.
          peerGate = await runPeerGate(execCwd, runtimeDir, cycleIdStr, peerGateMode, peerGateSinks, peerGateOpts);
          peerBlocked = peerGate.blocked;
        }
        if (peerBlocked && retry.status === "timeout" && readPeerOnPoolTimeout(ports.repoCwd) === "degrade") {
          // FIX-1234: the retry already rotated through EVERY hetero peer
          // (FIX-331) and the pool still produced no evidence because the peers
          // RAN but could not answer inside the timebox (timeout) — runtime-
          // proven UNAVAILABILITY, a different fact from a peer REFUSING or
          // ERRORING on the work. Blocking here left the delivery
          // with no path at all (intel-radar 2026-07-07: a 2-agent pool whose
          // only hetero peer timed out on every cycle deadlocked the project).
          // Owner ruling stands — "self only when hetero is truly impossible" —
          // so timebox-proven unavailability downgrades to the SAME recorded
          // self-review fallback that install-time absence gets (peer-gate
          // verdict `self-review-allowed`), with the unavailability written as
          // first-class evidence for audit/release gates. `error` / `empty` /
          // `none-available` keep the FIX-312 hard BLOCK (a misconfigured,
          // crashing, or hollow-answering peer must stay loud, not be waived —
          // only the timebox distinguishes true capacity unavailability), and
          // the review QUALITY
          // floor is untouched: the fresh-session Review Score gate still blocks
          // a delivery nobody scored.
          const how = retry.sameTypeFallback === true ? "same-type separate-session review" : "peer review";
          const unavailableDir = join(runtimeDir, "peer-unavailable");
          mkdirSync(unavailableDir, { recursive: true });
          writeFileSync(
            join(unavailableDir, `cycle-${cycleIdStr}.json`),
            JSON.stringify(
              {
                cycleId: cycleIdStr,
                status: retry.status,
                how,
                peer: retry.peer ?? null,
                attempts: 2,
                ts: eventTs(ports),
              },
              null,
              2,
            ),
            "utf8",
          );
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "peer:unavailable",
            cycleId: cycleIdStr,
            status: retry.status,
            ts: eventTs(ports),
          } as unknown as RollEvent);
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `peer gate (hard): peer pool unavailable after retry — the ${how} produced no evidence (${retry.status}) — cycle ${cycleIdStr} downgraded to recorded self-review fallback (peer_unavailable evidence written; Review Score gate still applies)`,
          );
          peerGate = {
            ...peerGate,
            verdict: "self-review-allowed",
            blocked: false,
            reasons: [`peer_unavailable_after_retry:${retry.status}`, ...peerGate.reasons],
          };
          peerBlocked = false;
        } else if (peerBlocked) {
          // FIX-312 unchanged: an erroring / absent peer is a violation-shaped
          // failure — escalate loud; the cycle ends NOT-Done.
          const how = retry.sameTypeFallback === true ? "same-type separate-session review" : "peer review";
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `peer gate (hard): high-complexity work still without peer evidence after one retry — the ${how} produced no evidence (${retry.status}) — cycle ${cycleIdStr} BLOCKED; story not marked Done`,
          );
        }
      }
      const storyId = ctx.storyId ?? "";
      // FIX-908: the score stage's result is no longer fire-and-forget. We capture
      // whether the SOLE producer of the cycle's Review Score (runScorePairing)
      // actually produced one ("scored") or failed loud (none-available / timeout /
      // error). A failed score stage on a cycle that did REAL work is the keystone
      // signal for the `needs_review` terminal (computed at facts-capture below).
      // Default "scored" so a NON-delivery cycle (commitsAhead===0 — the score
      // stage is never run) is never mis-flagged: needs_review is gated on
      // commitsAhead>0 anyway, so the default only matters when the stage ran.
      let scoreStatus: "none-available" | "scored" | "timeout" | "error" = "scored";
      // FIX-343 (step ③) pipeline order: peer-score → report render → attest gate
      // → terminal → teardown. The score stage runs BEFORE the report render so
      // the report embeds the FRESHLY-written peer score (never a stale one). A
      // fresh-session peer Reviewer (runScorePairing) is the SOLE producer of the
      // cycle's Review Score — the working agent NEVER grades its own delivery
      // (owner ruling 2026-06-16: an agent grading its own work is a conflict of
      // interest). When no peer can score (no candidate / timeout / error) NO note is
      // written: the attest gate then fails loud (`missing peer review score`)
      // and the cycle honestly fails — there is no runner-derived fallback.
      // US-CYCLE-008: skipped when the tier is unresolvable (no evaluator spawn).
      if (commitsAhead > 0 && storyId !== "" && !tierInfo.blocked) {
        // FIX-910 — emit a per-attempt score-stage failure event so every null
        // return from a scorer is OBSERVABLE (no more silently swallowed nulls).
        // The cause distinguishes unparseable / timeout / auth-block / exit-error.
        const emitScoreFailure = (peer: string, cause: "unparseable" | "timeout" | "auth-block" | "exit-error", detail?: string, artifactPath?: string): void => {
          ports.events.appendEvent(ports.paths.eventsPath, {
            type: "pair:score-failure",
            cycleId: ctx.cycleId ?? "",
            peer,
            cause,
            ...(detail !== undefined ? { detail: detail.slice(0, 200) } : {}),
            ...(artifactPath !== undefined ? { artifactPath } : {}),
            stage: "score",
            ts: eventTs(ports),
          });
        };
        // FIX-910 — single attempt wrapper: try spawning a scorer and parsing its
        // output. Returns the parsed score on success, or the failure cause on
        // null (after calling attributeBlockCause for auth/network detection).
        const tryScoreOnce = async (
          peer: string,
          prompt: string,
          timeoutMs: number,
        ): Promise<
          | { outcome: "parsed"; parsed: PairScore }
          | { outcome: "unparseable"; detail: string; artifactPath: string }
          | { outcome: "timeout"; detail: string; artifactPath?: string }
          | { outcome: "auth-block"; detail: string; artifactPath?: string }
          | { outcome: "exit-error"; detail: string; artifactPath: string }
        > => {
          const credentialBlock = blockIfAgentCredentialsMissing(peer, "score", ports, ctx);
          if (credentialBlock !== null) return { outcome: "auth-block", detail: credentialBlock };
          const scoreModel = configuredPeerModel(ports.repoCwd, peer); // US-PAIR-011
          let res;
          try {
            // US-CYCLE-002: the scorer sub-spawn is watchdog-wrapped (evaluator
            // role) for uniform accounting + no bypass; its own short `timeoutMs`
            // race remains the primary cap for this read-only scoring call.
            res = await Promise.race([
              spawnWatched({
                ports,
                ctx,
                purpose: "scorer",
                agent: peer,
                observeCwd: execCwd,
                run: () =>
                  ports.agentSpawn(peer, {
                    // E4: the scorer inspects the committed delivery, so it runs in the
                    // execution worktree (submodule cycle worktree for a submodule story).
                    cwd: execCwd,
                    skillBody: prompt,
                    timeoutMs, ...(scoreModel !== "" ? { model: scoreModel } : {}), // US-PAIR-011
                    ...(ctx.evidenceRunDir !== undefined ? { runDir: ctx.evidenceRunDir } : {}),
                  }),
              }).then((r) => r.result),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
            ]);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            await attributeBlockCause(peer, "error", detail, "score");
            return { outcome: "auth-block", detail };
          }
          if (res === null || res.timedOut) {
            const raw = res !== null ? `${res.stdout}\n${res.stderr}` : "";
            let artifactPath: string | undefined;
            if (res !== null) {
              artifactPath = savePeerRawOutput(peer, "score", res.stdout, res.stderr);
            }
            const blockCause = await attributeBlockCause(peer, "timeout", raw, "score");
            const detail = artifactPath !== undefined ? "timeout; raw output saved" : "timeout";
            // external block (auth/network) surfaced by attributeBlockCause → auth-block;
            // genuine slowness with no block signature → timeout.
            return blockCause === "auth" || blockCause === "network"
              ? { outcome: "auth-block", detail, artifactPath }
              : { outcome: "timeout", detail, artifactPath };
          }
          if (res.exitCode !== 0) {
            const raw = `${res.stdout}\n${res.stderr}`;
            const artifactPath = savePeerRawOutput(peer, "score", res.stdout, res.stderr);
            const blockCause = await attributeBlockCause(peer, "error", raw, "score");
            const detail = `exit code ${res.exitCode}; raw output saved`;
            return blockCause === "auth" || blockCause === "network"
              ? { outcome: "auth-block", detail, artifactPath }
              : { outcome: "exit-error", detail, artifactPath };
          }
          const diag = diagnosePairScoreOutput(res.stdout);
          if (!diag.ok) {
            // The reviewer ANSWERED but the format didn't match the strict
            // SCORE:/VERDICT:/RATIONALE: protocol — this is unparseable, NOT a
            // timeout/error. Previously silently discarded; now observable.
            // FIX-1045: carry the SPECIFIC reason + category so the role summary
            // can tell "returned score-like text but not accepted" from "no score
            // content returned" (beyond the generic "unparseable").
            const artifactPath = savePeerRawOutput(peer, "score", res.stdout, res.stderr);
            const detail =
              diag.category === "no-score-content"
                ? `no score content returned: ${diag.reason}`
                : `returned score-like text but not accepted: ${diag.reason}`;
            return { outcome: "unparseable", detail, artifactPath };
          }
          return { outcome: "parsed", parsed: { ...diag.score, ...peerRunIdentity(peer, res.stdout, scoreModel) } };
        };
        const scorePeer = async (peer: string, summary: string, timeoutMs: number): Promise<PairScore | null> => {
          const prompt = buildPairScorePrompt(summary, evalContractFormatted);
          // First attempt
          const first = await tryScoreOnce(peer, prompt, timeoutMs);
          if (first.outcome === "parsed") return first.parsed;
          emitScoreFailure(peer, first.outcome, first.detail, first.artifactPath);
          // FIX-910 unparseable rescue: the reviewer ANSWERED but the format was
          // off. Give ONE retry with a stricter format reminder — the reviewer
          // already did the cognitive work; the harness just needs a parseable
          // reply. Only unparseable gets a retry; timeout/auth/exit-error do not
          // (they indicate a real spawn/process problem, not a format issue).
          if (first.outcome === "unparseable") {
            const retryPrompt = buildPairScorePrompt(summary, evalContractFormatted) +
              "\n\n你上次回复缺/错了 SCORE/VERDICT/RATIONALE 行，请严格只回这三行。";
            const retry = await tryScoreOnce(peer, retryPrompt, timeoutMs);
            if (retry.outcome === "parsed") return retry.parsed;
            emitScoreFailure(peer, retry.outcome, retry.detail, retry.artifactPath);
          }
          return null;
        };
        let diffStat = "";
        try {
          // E4: diff against the EXECUTION repo's integration branch (a submodule
          // cycle branched off the submodule's own integration branch, E1
          // `resolveIntegrationBranch(<submodule repo>)`, NOT the superproject's
          // origin/main) and run it in the execution worktree. No targetSubmodule ⇒
          // resolveIntegrationBranch(ports.repoCwd) which defaults to origin/main —
          // byte-identical to the prior hardcode.
          const diffBase = resolveIntegrationBranch(execRepoCwd);
          const { stdout } = await execFileAsync("git", ["diff", "--stat", `${diffBase}...HEAD`], { cwd: execCwd, encoding: "utf8" });
          diffStat = stdout.slice(0, 4_000);
        } catch {
          /* summary degrades gracefully */
        }
        // FIX-363: give the scorer the story's GOAL so it grades against intent —
        // a removal card's deletions are the deliverable, not a regression (a scorer
        // blind to the goal scored a clean roll-sentinel deletion 3/10 and jammed the
        // loop). Best-effort: a missing/unreadable spec degrades to the id-only line.
        let goalLine = "";
        let evalContractFormatted = "";
        try {
          const specPath = join(cardArchiveDir(ports.repoCwd, storyId), "spec.md");
          if (existsSync(specPath)) {
            const specText = readFileSync(specPath, "utf8");
            const title = (/^title:\s*(.+)$/m.exec(specText)?.[1] ?? "").trim();
            if (title !== "") goalLine = `Goal: ${title}\n`;
            // US-SKILL-030: pass evaluation contract to scorer so it grades against
            // the story's intended evidence/focus, not just generic code quality.
            evalContractFormatted = formatEvaluationContractForScorer(parseEvaluationContract(specText));
          }
        } catch {
          /* best-effort — the scorer still gets the diff stat */
        }
        const summary = `Story: ${storyId}\n${goalLine}Delivery: peer-reviewed cycle, scoring stage\nDiff stat:\n${diffStat}`;
        const skill = storyId.startsWith("FIX-") || storyId.startsWith("BUG-") ? "roll-fix" : "roll-build";
        // Write to the PERSISTENT .roll (repoCwd) so the peer score note survives
        // worktree teardown and the gate (reading repoCwd) finds it. FIX-343: use
        // the SAME injectable installed-agents seam as the peer gate so the
        // mandatory score stage is hermetic under test (no real-env spawns).
        // FIX-908: CONSUME the result (was fire-and-forget). A non-"scored" status
        // means the gate will fail loud on "missing peer review score"; we remember
        // it so a cycle that nonetheless did real work is classified `needs_review`
        // (work preserved) rather than plain `failed` + orphaned branch. The score
        // note itself is still written ONLY by runScorePairing — we synthesize
        // nothing here (the independence red line stands).
        const scoreStartMs = Date.now();
        const scoreResult = await runScorePairing(ports.repoCwd, dirname(ports.paths.eventsPath), ctx.cycleId ?? "", ctx.agent ?? "", storyId, skill, summary, {
          installed: ports.installedAgents?.() ?? agentsInstalled(realAgentEnv()),
          // Historical auth streaks do not shrink the fair candidate pool.
          isAvailable: peerAvailable,
          scorePeer,
          event: (e: PairEvent) => ports.events.appendEvent(ports.paths.eventsPath, e as RollEvent),
          now: () => eventTs(ports),
          // FIX-935: respect project-config agent allowlist.
          allowedAgents: peerGateAllowedAgents,
          // US-CYCLE-008: high-tier → parallel adversarial panel; else serial default.
          ...(evalFanout !== undefined ? { fanout: evalFanout } : {}),
        });
        scoreStatus = scoreResult.status;
        // US-CYCLE-008 (AC4): journal the DECLARED tier + ACTUAL panel composition.
        recordEvaluatorPanelRound(ports, ctx, { tier: tierInfo.tier, panel: scoreResult.panel, outcome: scoreStatus, startMs: scoreStartMs, endMs: Date.now() });
      }
      let attestRenderExitCode = 0;
      // US-CYCLE-008: skipped on a tier-blocked cycle (ac-map self-heal spawns).
      if (commitsAhead > 0 && storyId !== "" && !tierInfo.blocked && ctx.evidenceRunDir !== undefined && ctx.evidenceRunDir !== "") {
        const remediationAgent = ctx.agent ?? "claude";
        const selfHeal = await runAcMapSelfHeal({
          // E4: the remediation agent inspects the delivery + collects git evidence
          // in the execution worktree, but the ac-map/spec it heals live in the
          // persistent `.roll` (archiveCwd = ports.repoCwd, superproject — unchanged).
          worktreeCwd: execCwd,
          archiveCwd: ports.repoCwd,
          storyId,
          runDir: ctx.evidenceRunDir,
          cycleId: ctx.cycleId ?? "",
          agent: remediationAgent,
          collectDraftEvidence: () => collectDraftEvidence(execCwd, execRepoCwd),
          collectCycleSignals: () => {
            try {
              const bus = new EventBus();
              const events = bus.readEvents(ports.paths.eventsPath);
              const cycleEvents = events.filter(
                (e) => "cycleId" in e && (e as { cycleId?: string }).cycleId === ctx.cycleId,
              );
              return cycleEvents.length > 0 ? cycleActivityFromEvents(cycleEvents, ctx.cycleId ?? "") : undefined;
            } catch {
              return undefined;
            }
          },
          canSpawnRemediation: () => blockIfAgentCredentialsMissing(remediationAgent, "build", ports, ctx) === null,
          agentSpawn: ports.agentSpawn,
          // E4: a submodule cycle's remediation agent commits into the SUBMODULE's
          // object store, so it needs write access to the submodule's git-common-dir
          // (as well as the superproject `.roll`). No targetSubmodule ⇒ exactly
          // agentWritableRoots(ports.repoCwd, …), unchanged.
          writableRoots: submoduleAgentWritableRoots(ports.repoCwd, execRepoCwd, ports.paths.alertsPath),
          // E9 (PR9): the attest RENDER reads the story SPEC (design truth) to build
          // the acceptance report, so it must render from the LIVE `.roll`
          // (ports.repoCwd) — the same tree the picker/designer read
          // (`storySpecPath(ports.repoCwd, id)`). Rendering from the worktree
          // snapshot fataled ("story not found") on a project that TRACKS `.roll`
          // whenever the new spec was still uncommitted (linkRollIntoWorktree keeps
          // the committed snapshot, not a symlink). For a NON-tracked-`.roll`
          // project the worktree `.roll` is symlinked to repoCwd's `.roll`, so this
          // is byte-identical. Evidence output still lands under the card's `.roll`
          // per the existing archive convention (the gate reads it worktree-first,
          // repoCwd-fallback), so the render output location is unchanged.
          renderAttest: () => ports.attest.render(ports.repoCwd, storyId, ctx.evidenceRunDir ?? ""),
          appendEvent: (event) => ports.events.appendEvent(ports.paths.eventsPath, event),
          now: () => eventTs(ports),
        });
        if (selfHeal.renderExitCode !== 0) {
          attestRenderExitCode = selfHeal.renderExitCode;
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `attest render failed for ${storyId} in cycle ${ctx.cycleId ?? ""} (exit ${selfHeal.renderExitCode})`,
          );
        }
      }
      // FIX-207 attest gate: a delivery (commits ahead + a real story) that ships
      // with no FRESH acceptance report leaves an auditable ALERT + `attest:gate`
      // event. HARD by default; `loop_safety.attest_gate: soft` in policy.yaml
      // records without blocking for explicit migration windows. A hard-blocked
      // delivery is captured as a failed agent exit so the story is NOT marked
      // Done without acceptance evidence.
      // Scoped to actual deliveries: an idle cycle has nothing to attest.
      let attestBlocked = false;
      // Capture the attest reasons so the Full Delta repair decision can frame
      // the Evaluator→Builder signal with the cycle's blocking findings.
      let attestReasons: readonly string[] = [];
      // US-CYCLE-008: skipped on a tier-blocked cycle (tier block dominates).
      if (commitsAhead > 0 && storyId !== "" && !tierInfo.blocked) {
        const mode = readAttestGateMode(ports.repoCwd);
        const res = runAttestGate(
          ports.paths.worktreePath,
          storyId,
          ctx.cycleId ?? "",
          mode,
          ctx.startSec,
          {
            alert: (m) => ports.events.appendAlert(ports.paths.alertsPath, m),
            event: (p) =>
              ports.events.appendEvent(ports.paths.eventsPath, {
                type: "attest:gate",
                cycleId: p.cycleId,
                verdict: p.verdict,
                reasons: p.reasons,
                ts: eventTs(ports),
              }),
          },
          // FIX-343: read the peer score from the PERSISTENT .roll (repoCwd) —
          // where runScorePairing wrote it — not the ephemeral worktree; thread
          // the BUILDER SESSION ID (step ①) so the gate verifies the scorer's
          // session ≠ the builder's session (an independent fresh session scored
          // this, never the builder's own in-session/sub-agent grading). The
          // vendor-name comparison is gone — a same-vendor fresh session is valid.
          ports.repoCwd,
          ctx.builderSessionId ?? "",
          attestRenderExitCode,
          // E9 (PR9): resolve the SPEC (design truth) from the LIVE `.roll`
          // (ports.repoCwd), aligning attest with the picker/designer
          // (`storySpecPath(ports.repoCwd, id)`). This is the spec-resolution cwd
          // ONLY — evidence/score keep the worktree/scoreRepoCwd semantics above.
          // A tracked-`.roll` project's uncommitted spec is otherwise invisible in
          // the worktree snapshot (mis-read as "not found"); a non-tracked project's
          // worktree `.roll` is symlinked to repoCwd's, so this is byte-identical.
          ports.repoCwd,
        );
        if (res.verdict === "skipped") {
          applyCorrectionAction({
            projectPath: ports.repoCwd,
            eventsPath: ports.paths.eventsPath,
            alertsPath: ports.paths.alertsPath,
            storyId,
            cycleId: ctx.cycleId ?? "",
            reasons: res.reasons,
            nowSec: ports.clock(),
          });
        }
        attestBlocked = res.blocked;
        attestReasons = res.reasons;
      }
      // US-DELTA-007: for verified/designed (Full Delta) profiles, an
      // independently-cast Evaluator must AUTHOR its own eval-report.md
      // (## Inputs checked + ## Rationale) and v2 manifest. capture-facts only
      // VALIDATES that output — it NEVER assembles the report from score/attest
      // fields. A missing/malformed/legacy-assembled report, an unresolved
      // Evaluator, or a same-session evaluation BLOCKS delivery (fail-closed,
      // `artifact_invalid`/`identity_collision`) before any publish/merge — the
      // story is never marked Done. US-V4-007: the bounded repair DECISION
      // (decideRepair) frames the Evaluator→Builder repair signal; the live
      // re-spawn loop that consumes a `repair` action is v4.1.
      let evaluatorBlocked = false;
      if (
        (ctx.selectedProfile === "verified" || ctx.selectedProfile === "designed") &&
        commitsAhead > 0 &&
        storyId !== "" &&
        // US-CYCLE-008: the Full Delta Evaluator spawns — skip on a tier-blocked cycle.
        !tierInfo.blocked
      ) {
        const ev = await runEvaluatorStage(ports, ctx);
        const evReasons = attestBlocked || peerBlocked ? attestReasons : [];
        if (!ev.ok) {
          evaluatorBlocked = true;
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `evaluator artifact (${ctx.selectedProfile}) BLOCKED [${ev.blockReason ?? "artifact_invalid"}] for ${storyId}: ${ev.reasons.join("; ")} — Full Delta delivery held (no publish/merge); an independently authored eval-report.md (## Inputs checked + ## Rationale) with its own v2 manifest is REQUIRED — cycle ${ctx.cycleId ?? "?"}`,
          );
        }
        const blocking = [...evReasons, ...(evaluatorBlocked ? ev.reasons : [])];
        const repair = decideRepair(blocking, initialRepairState(), { maxRounds: DEFAULT_MAX_REPAIR_ROUNDS });
        if (repair.action !== "done") {
          ports.events.appendAlert(
            ports.paths.alertsPath,
            `repair decision (${ctx.selectedProfile}) for ${storyId}: ${repair.action} — ${repair.reason} (live repair loop is v4.1; cycle held for review) — cycle ${ctx.cycleId ?? "?"}`,
          );
        }
      }
      // FIX-244: phantom-failure probe. A hard-blocked delivery whose work is
      // ALREADY out as a PR (agent self-published, observed 2026-06-10: cycles
      // judged failed whose PRs merged minutes later) is "published", not a
      // no-output failure. Probe the cycle branch's PR state into the facts so
      // classifyCaptured can see it; a failed probe degrades to plain failed.
      let prState: string | undefined;
      if (attestBlocked && commitsAhead > 0) {
        prState = await ports.github.prState(ports.repoCwd, ctx.branch).catch(() => undefined);
      }
      // Hook 1 (productivity floor): reaching capture means an agent WAS spawned
      // this cycle (the no_story no-op terminates idle before ever capturing). An
      // executed cycle that leaves 0 commits is therefore a `gave_up`, NOT a
      // silent idle. The signal mirrors the `rowSpentZeroNoExecution` semantics:
      // an agent slot is set, and the spawn ran (its spend/duration are recorded
      // on the runs row). A defensively-empty agent slot stays idle.
      const agentExecuted = (ctx.agent ?? "").trim() !== "";
      // US-V4-005: a verified/designed cycle with an invalid Evaluator artifact is
      // gate-blocked (fail-closed) alongside the attest/peer gates.
      // US-CYCLE-008: a new-regime card with no valid risk_tier is hard-blocked
      // (tierInfo.blocked) — evaluation depth unresolved, fail-loud not low-default.
      const gateBlocked = attestBlocked || peerBlocked || evaluatorBlocked || tierInfo.blocked;
      // FIX-908: a gate-blocked cycle that did REAL work (≥1 commit AND ≥1 tcr:
      // commit) but is only missing a REQUIRED acceptance artifact — the
      // independent peer Review Score was not produced (scoreStatus ≠ "scored") OR
      // the acceptance report is an empty shell (no AC content / no ac-map) — is
      // NOT a no-output failure. The work is sound and committed; the attest gate
      // has already honestly blocked Done (no synthesized artifact). Flag it so
      // classifyCaptured returns `needs_review` (branch preserved, awaits review)
      // instead of plain `failed` + an orphaned, discarded branch. Scoped tightly:
      // ONLY when blocked, with real work, and no PR already out (the FIX-244
      // published path arbitrates that case first). NEVER set on a passing gate or
      // on a 0-commit / 0-tcr give-up — those stay `failed`/`gave_up`/`idle`.
      const missingRequiredArtifact =
        scoreStatus !== "scored" ||
        (storyId !== "" && !verificationReportHasContent(ports.paths.worktreePath, storyId, ports.repoCwd));
      const needsReview =
        gateBlocked &&
        commitsAhead > 0 &&
        tcrCount > 0 &&
        missingRequiredArtifact &&
        prState !== "OPEN" &&
        prState !== "MERGED";
      const facts: CapturedFacts = {
        usedWorktree: true,
        agentExecuted,
        // The real agent process exit code (from agent_exited), NOT the
        // gate-block signal. `gateBlocked` is the separate hard-attest/peer
        // rejection channel. Non-zero agent exit + commits with no gate block
        // is now "built" (agent did real work despite a non-zero exit — e.g. pi
        // often exits ≠0 after a successful build).
        agentExit: ctx.agentExitCode ?? 0,
        timedOut: false,
        commitsAhead,
        ...(gateBlocked ? { gateBlocked: true } : {}),
        ...(needsReview ? { needsReview: true } : {}),
        ...(mainAhead > 0 ? { mainAhead } : {}),
        ...(mainDirty ? { mainDirty: true, mainDirtyFiles } : {}),
        ...(worktreeDirty ? { worktreeDirty: true } : {}),
        ...(mainAhead > 0 || mainDirty
          ? { attemptedCwd: ports.repoCwd, expectedWorktreeCwd: ports.paths.worktreePath }
          : {}),
        ...(ctx.agentInternalFailure !== undefined ? { agentInternalFailure: ctx.agentInternalFailure } : {}),
        ...(prState !== undefined ? { prState } : {}),
      };
      return { event: { type: "facts_captured", facts }, ctxPatch: { tcrCount, ...(mainDirty ? { mainDirty: true } : {}) } };
}

/**
 * FIX-912 — collect the git evidence the ac-map draft generator needs.
 * Three cheap git calls in the worktree; each has a hard cap so they never
 * stall the cycle (a single cycle's worth of commits + diff is small).
 * Best-effort: on ANY failure returns an empty evidence structure (the draft
 * generator then produces an all-`needs-confirmation` skeleton). The cap
 * values are generous for a normal cycle but bounded for safety.
 *
 * E4: `repoCwd` (the EXECUTION repo root) resolves the diff baseline — a submodule
 * cycle diffs against the SUBMODULE's own integration branch, not the
 * superproject's origin/main. Absent/superproject ⇒ resolveIntegrationBranch
 * defaults to origin/main (byte-identical to the prior hardcode).
 */
async function collectDraftEvidence(worktreeCwd: string, repoCwd: string): Promise<DraftEvidence> {
  const empty: DraftEvidence = { commitLines: [], diffStatLines: [], changedFilenames: [] };
  const base = resolveIntegrationBranch(repoCwd);
  try {
    const [commits, diffStat, changedFiles] = await Promise.all([
      execFileAsync("git", ["log", "--oneline", `${base}..HEAD`, "-n", "50"], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((r) => r.stdout.trim().split("\n").filter((l) => l !== ""), () => [] as string[]),
      execFileAsync("git", ["diff", "--stat", `${base}...HEAD`], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((r) => r.stdout.trim().split("\n").filter((l) => l !== ""), () => [] as string[]),
      execFileAsync("git", ["diff", "--name-only", `${base}...HEAD`], {
        cwd: worktreeCwd,
        encoding: "utf8",
        timeout: 15_000,
      }).then((r) => r.stdout.trim().split("\n").filter((l) => l !== ""), () => [] as string[]),
    ]);
    return { commitLines: commits, diffStatLines: diffStat, changedFilenames: changedFiles };
  } catch {
    return empty;
  }
}
