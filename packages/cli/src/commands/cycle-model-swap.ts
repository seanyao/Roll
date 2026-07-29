/**
 * US-CYCLE-012 — `roll loop cycle model-swap [<card>] [--adjudicate] [--json]`.
 *   • no card (or --list): list every card carrying a pending swap candidate.
 *   • <card> (no flag): write/refresh the candidate file (idempotent) and print.
 *   • <card> --adjudicate: run the heterogeneous consensus over each candidate,
 *     record the auditable decision (agree ⇒ approved-record; disagree/none ⇒
 *     escalate), and emit a model:swap_decision event. NEVER rewrites agents.yaml.
 *
 * The adjudicator is injectable (tests pass a deterministic one); the production
 * default reuses the peer primitive over heterogeneous fresh sessions.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_FILE, serializeEvent } from "@roll/core";
import type { RollEvent } from "@roll/spec";
import { agentsInstalled } from "@roll/core";
import { realAgentEnv } from "./agent-list.js";
import { cardArchiveDir } from "../lib/archive.js";
import {
  decideSwap,
  listPendingCandidates,
  recordSwapDecision,
  swapCandidates,
  writeCandidates,
  type SwapAdjudicator,
  type SwapCandidate,
  type SwapVerdict,
} from "../lib/model-swap.js";
import { spawnPeerReviewAgent } from "./peer.js";

/** Build the production adjudicator: heterogeneous installed agents, each a fresh
 *  peer session, voting agree/disagree on the swap candidate. Session-independent
 *  by construction (spawnPeerReviewAgent forks a distinct subprocess per agent). */
export function peerConsensusAdjudicator(projectPath: string): SwapAdjudicator {
  return async (candidate: SwapCandidate): Promise<SwapVerdict[]> => {
    // Heterogeneous pool: distinct installed agents (bounded to 3). The candidate
    // is about a MODEL; every independent agent is a valid heterogeneous voter.
    const pool = uniqueStrings(agentsInstalled(realAgentEnv())).slice(0, 3);
    if (pool.length === 0) return [{ agent: "(none)", verdict: "error", detail: "no installed agents" }];
    const prompt = buildAdjudicationPrompt(candidate);
    const verdicts: SwapVerdict[] = [];
    for (const agent of pool) {
      const res = await spawnPeerReviewAgent({ agent, prompt, projectPath, timeoutMs: 120_000 });
      if (res.status !== "ok") {
        verdicts.push({ agent, verdict: "error", detail: res.status });
        continue;
      }
      const m = /VERDICT:\s*(agree|disagree)/i.exec(res.stdout);
      if (m === null) verdicts.push({ agent, verdict: "error", detail: "unparseable verdict" });
      else verdicts.push({ agent, verdict: m[1]!.toLowerCase() === "agree" ? "agree" : "disagree" });
    }
    return verdicts;
  };
}

function buildAdjudicationPrompt(c: SwapCandidate): string {
  return [
    `A roll rig (role "${c.role}" running model "${c.model}") has failed the same card ${c.streak} times in a row`,
    `(recent outcomes: ${c.recentOutcomes.join(", ")}).`,
    `Question: is swapping the MODEL bound to this role a reasonable next step to stop burning cycles?`,
    `Reply with a one-line rationale, then a final line exactly: VERDICT: agree  or  VERDICT: disagree`,
  ].join("\n");
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

function emit(repoCwd: string, ev: RollEvent): void {
  try {
    const loopDir = join(repoCwd, ".roll", "loop");
    mkdirSync(loopDir, { recursive: true });
    appendFileSync(join(loopDir, EVENTS_FILE), serializeEvent(ev) + "\n");
  } catch {
    /* best-effort observability */
  }
}

export async function cycleModelSwapCommand(
  args: string[],
  lang: "en" | "zh",
  adjudicator?: SwapAdjudicator,
): Promise<number> {
  const json = args.includes("--json");
  const adjudicate = args.includes("--adjudicate");
  const cardId = args.find((a) => !a.startsWith("-"));
  const cwd = process.cwd();

  if (cardId === undefined || cardId === "" || args.includes("--list")) {
    const pending = listPendingCandidates(cwd);
    if (json) {
      process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      pending.length === 0
        ? lang === "zh"
          ? "暂无待处理的换模型候选\n"
          : "no pending model-swap candidates\n"
        : (lang === "zh" ? "待处理换模型候选:\n" : "pending model-swap candidates:\n") + pending.map((p) => `  ${p.card}  ${p.path}`).join("\n") + "\n",
    );
    return 0;
  }

  const cardDir = cardArchiveDir(cwd, cardId);
  const candidates = swapCandidates(cardDir, cardId);
  if (candidates.length === 0) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ card: cardId, candidates: [] }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(lang === "zh" ? `${cardId}: 无连败达阈值的 rig,无候选\n` : `${cardId}: no rig at the consecutive-failure threshold — no candidate\n`);
    return 0;
  }

  if (!adjudicate) {
    const { path } = writeCandidates(cardDir, cardId, candidates);
    if (json) {
      process.stdout.write(`${JSON.stringify({ card: cardId, candidates, path }, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      (lang === "zh" ? `${cardId}: ${candidates.length} 个换模型候选 (用 --adjudicate 交异构共识裁决):\n` : `${cardId}: ${candidates.length} swap candidate(s) (pass --adjudicate for consensus):\n`) +
        candidates.map((c) => `  ${c.role} × ${c.model}: ${c.streak} consecutive failures`).join("\n") +
        "\n",
    );
    return 0;
  }

  const adj = adjudicator ?? peerConsensusAdjudicator(cwd);
  const results: { candidate: SwapCandidate; decision: string; reason: string }[] = [];
  for (const cand of candidates) {
    const verdicts = await adj(cand);
    const decision = decideSwap(verdicts);
    const { decisionPath } = recordSwapDecision(cardDir, cand, decision);
    emit(cwd, { type: "model:swap_decision", card: cardId, role: cand.role, model: cand.model, decision: decision.decision, path: decisionPath, ts: Date.now() });
    results.push({ candidate: cand, decision: decision.decision, reason: decision.reason });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ card: cardId, results }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    results
      .map((r) => `  ${r.candidate.role} × ${r.candidate.model}: ${r.decision} — ${r.reason}`)
      .join("\n") + "\n",
  );
  return 0;
}
