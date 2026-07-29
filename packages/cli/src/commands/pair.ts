/**
 * Cross-Agent Pairing CLI surface.
 *   `roll pair status` (US-PAIR-002) — observability: who is in the pairing pool,
 *     their vendor + capability, and why an agent is excluded. Observability is a
 *     first-class need; kept OFF `roll agent list` (byte-difftest'd) by living
 *     under `pair` so the existing command's output is untouched.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  agentDisplayName,
  agentsInstalled,
  aggregatePairingCost,
  type PairingCostSummary,
} from "@roll/core";
import { parseEventLine, type RollEvent } from "@roll/spec";
import { peerReviewCost } from "@roll/core";
import { buildDesignScorePrompt, buildPairScorePrompt, diagnosePairScoreOutput, runScorePairing, type PairEvent } from "../runner/pairing-gate.js";
import { formatEvaluationContractForScorer, parseEvaluationContract } from "../lib/evaluation-contract.js";
import { cardArchiveDir } from "../lib/archive.js";
import { projectAgent, realAgentEnv } from "./agent-list.js";
import { spawnPeerReviewAgent, type SpawnPeerReviewInput, type SpawnPeerReviewResult } from "./peer.js";
import { loopRuntimeDir, projectSlug, sharedRoot } from "./dashboard.js";
import { resolveScopedCastRole } from "../runner/scoped-route.js";

const HELP = `Usage: roll pair <status|score>
  status           Show the pairing pool: who pairs, vendor, capability, why excluded.
  score <story-id> [--design] [--summary <text>|--file <path>] [--skill <name>] [--worker <agent>] [--timeout-ms <ms>]
                   Ask a fresh-session peer Reviewer to score a finished cycle
                   (US-PAIR-009/010). No peer ⇒ no Review Score (fail loud); the
                   working agent never grades its own work.
                   --design  grade roll-design OUTPUT (INVEST split, visual-AC
                             completeness, deliverables, domain consistency) — NOT
                             code; stamps the score as stage=design (FIX-344).
                             Defaults --skill to roll-design.
  status 显示结对池：谁能结对、厂商、能力、谁因何被排除。
  score  让独立新 session 的评审 agent 给完成的 cycle 打分；无可用评审则无评审分（诚实失败），工作 agent 永不自评。
         --design 评 roll-design 的设计产出（INVEST 拆分、可视 AC 完整、deliverable 声明、领域一致），
                  非代码；记为 stage=design（FIX-344）；--skill 默认 roll-design。
`;

export function pairCommand(args: string[]): number | Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if ((args[0] === "legacy" && args[1] === "init") || args[0] === "init") return pairInit();
  if (args[0] === "status") return pairStatus(args.slice(1));
  if (args[0] === "score") return pairScore(args.slice(1));
  process.stderr.write(`[roll] unknown pair subcommand: ${args[0]}\n`);
  process.stderr.write(HELP);
  return 1;
}

function pairInit(): number {
  process.stderr.write(
    "[roll] `roll pair init` is retired. Bind reviewers with .roll/agents.yaml defaults.story.roles.evaluate.\n" +
      "[roll] `roll pair init` 已退役；请在 .roll/agents.yaml 的 defaults.story.roles.evaluate 绑定评审者。\n",
  );
  return 1;
}

function pairStatus(rest: string[]): number {
  if (rest.length > 0) {
    process.stderr.write(`[roll] unexpected argument(s): ${rest.join(" ")}\n`);
    return 1;
  }
  const route = resolveScopedCastRole(process.cwd(), "evaluator");
  if (route === null || !route.resolution.ok) {
    process.stdout.write(
      "No scoped evaluator binding. Configure .roll/agents.yaml defaults.story.roles.evaluate.\n" +
        "未配置 scoped evaluator binding；请在 .roll/agents.yaml 的 defaults.story.roles.evaluate 中配置。\n",
    );
    return 0;
  }
  const noColor = (process.env["NO_COLOR"] ?? "") !== "";
  const GREEN = noColor ? "" : "\x1b[0;32m";
  const DIM = noColor ? "" : "\x1b[0;90m";
  const NC = noColor ? "" : "\x1b[0m";
  const out: string[] = ["", "  Cross-Agent Pairing — scoped evaluator pool / 结对评审池", ""];
  out.push(`  strategy: ${route.resolution.resolved.selectedStrategy}`, "");
  for (const agent of route.resolution.resolved.candidates) {
    const disp = agentDisplayName(agent);
    out.push(`    ${GREEN}✓ ${disp}${NC}  ${DIM}scoped story.evaluate candidate${NC}`);
  }
  out.push("");
  out.push(renderPairingActivity(pairingActivitySummary(), { noColor }));
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

/** ndjson files holding this project's events (loop runtime dir, then shared). */
function pairingEventFiles(): string[] {
  const slug = projectSlug();
  const candidates: string[] = [];
  const rtDir = loopRuntimeDir(slug);
  if (rtDir !== null) {
    candidates.push(join(rtDir, "events.ndjson"));
    for (let i = 1; i < 5; i++) candidates.push(join(rtDir, `events.ndjson.${i}`));
  }
  candidates.push(join(sharedRoot(), "loop", `events-${slug}.ndjson`));
  for (let i = 1; i < 5; i++) candidates.push(join(sharedRoot(), "loop", `events-${slug}.ndjson.${i}`));
  return candidates.filter((p) => existsSync(p));
}

/**
 * Read this project's pair:* events and fold them into a {@link PairingCostSummary}.
 * Best-effort: a missing/unreadable stream yields the zero summary (never throws),
 * so `roll pair status` always renders something.
 */
function pairingActivitySummary(): PairingCostSummary {
  const events: RollEvent[] = [];
  // De-dup identical lines across rotated/shared files (pi pair-review): a
  // rotation that copies rather than moves could otherwise double-count.
  const seen = new Set<string>();
  for (const p of pairingEventFiles()) {
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || seen.has(trimmed)) continue;
      seen.add(trimmed);
      const e = parseEventLine(trimmed);
      if (e !== null) events.push(e);
    }
  }
  return aggregatePairingCost(events);
}

/**
 * Render the pairing activity/spend block (US-PAIR-006, cost observability):
 * "pairings to date: N, by peer (codex×K…), total cost $X, M findings". Pure
 * (summary → string) so it is unit-testable; the CLI locates the events and
 * prints this. Bilingual: English + Chinese on separate lines (project
 * convention). Always renders, even at zero activity.
 */
export function renderPairingActivity(summary: PairingCostSummary, opts: { noColor: boolean }): string {
  const DIM = opts.noColor ? "" : "\x1b[0;90m";
  const NC = opts.noColor ? "" : "\x1b[0m";
  const byPeer = Object.keys(summary.byPeer)
    .sort((a, b) => (summary.byPeer[b] ?? 0) - (summary.byPeer[a] ?? 0) || a.localeCompare(b))
    .map((p) => `${agentDisplayName(p)}×${summary.byPeer[p]}`)
    .join(", ");
  const cost = `$${summary.totalCost.toFixed(2)}`;
  const peerStr = byPeer === "" ? "—" : byPeer;
  // Legacy pair:excluded events are diagnostics only in V4; they no longer
  // shrink the fair candidate pool. Empty → "—".
  const excluded = summary.excludedPeers ?? {};
  const excludedStr =
    Object.keys(excluded).length === 0
      ? "—"
      : Object.keys(excluded)
          .sort()
          .map((p) => `${agentDisplayName(p)}(auth×${excluded[p]})`)
          .join(", ");
  const lines: string[] = [
    `  Pairing activity — 结对活动`,
    `  ${DIM}pairings to date: ${summary.pairings} · by peer: ${peerStr}${NC}`,
    `  ${DIM}total cost: ${cost} · findings: ${summary.totalFindings} · none-available: ${summary.noneAvailable}${NC}`,
    `  ${DIM}legacy auth streaks: ${excludedStr}${NC}`,
    `  ${DIM}累计结对：${summary.pairings} 次 · 各 peer：${peerStr}${NC}`,
    `  ${DIM}总花费：${cost} · 发现问题：${summary.totalFindings} · 无可用 peer：${summary.noneAvailable}${NC}`,
    `  ${DIM}legacy auth streak：${excludedStr}${NC}`,
  ];
  return lines.join("\n");
}

// ── US-PAIR-010: `roll pair score` — the manual surface for the score stage ──

export interface PairScoreCmdDeps {
  installed: string[];
  isAvailable: (agent: string) => boolean;
  /** The agent whose work is being scored (default: the project agent). */
  workingAgent: () => string;
  /** Reviewer spawn seam (default: the `roll peer` text-agent spawn). */
  spawnReviewer: (input: SpawnPeerReviewInput) => Promise<SpawnPeerReviewResult>;
}

const PAIR_SCORE_TIMEOUT_MS = 180_000;

function defaultPairScoreDeps(): PairScoreCmdDeps {
  return {
    installed: agentsInstalled(realAgentEnv()),
    isAvailable: () => true,
    workingAgent: () => projectAgent(),
    spawnReviewer: spawnPeerReviewAgent,
  };
}

/** Best-effort event sink: manual score pairings land in the same shared event
 *  stream `roll pair status` aggregates, so the activity/spend ledger sees them. */
function appendPairEvent(e: PairEvent): void {
  try {
    const dir = join(sharedRoot(), "loop");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `events-${projectSlug()}.ndjson`), `${JSON.stringify(e)}\n`, "utf8");
  } catch {
    /* observability is best-effort — never fail the command */
  }
}

function writeManualScoreRawArtifact(projectPath: string, cycleId: string, peer: string, stage: "score" | "design", attempt: number, stdout: string): string {
  const dir = join(projectPath, ".roll", "peer");
  mkdirSync(dir, { recursive: true });
  const artifactPath = join(dir, `cycle-${cycleId}.${stage}.${peer}.attempt-${attempt}.raw.txt`);
  writeFileSync(artifactPath, stdout, "utf8");
  return artifactPath;
}

/** Summary precedence: --summary > --file > the story's backlog row. */
export function resolveSummary(storyId: string, summaryFlag?: string, fileFlag?: string): string | null {
  if (summaryFlag !== undefined && summaryFlag.trim() !== "") return summaryFlag.trim();
  if (fileFlag !== undefined) {
    try {
      return readFileSync(fileFlag, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  try {
    const backlog = readFileSync(join(process.cwd(), ".roll", "backlog.md"), "utf8");
    // FIX-1475: select the row by an EXACT id-cell match (link-stripped) — never a
    // whole-line boundary regex. The prior `${id}(?![A-Za-z0-9])` still allowed a
    // trailing `-`, so FIX-300 matched a FIX-300-legacy row (and any row whose
    // DESCRIPTION merely mentioned the id), feeding the wrong summary to scoring.
    const row = backlog.split("\n").find((l) => {
      if (!l.startsWith("|")) return false;
      const cell = (l.split("|")[1] ?? "").trim();
      const id = cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
      return id === storyId;
    });
    return row !== undefined ? `Story ${storyId} — backlog row:\n${row.trim()}` : null;
  } catch {
    return null;
  }
}

export async function pairScore(rest: string[], deps: PairScoreCmdDeps = defaultPairScoreDeps()): Promise<number> {
  const flagsWithValue = new Set(["--summary", "--file", "--timeout-ms", "--skill", "--worker"]);
  // FIX-344: --design is a boolean flag (grade roll-design OUTPUT, not a code cycle).
  const boolFlags = new Set(["--design"]);
  let storyId: string | undefined;
  let design = false;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (boolFlags.has(a)) {
      design = true;
    } else if (flagsWithValue.has(a)) {
      const v = rest[i + 1];
      if (v === undefined) {
        process.stderr.write(`[roll] ${a} requires a value\n${HELP}`);
        return 1;
      }
      flags.set(a, v);
      i++;
    } else if (a.startsWith("-")) {
      process.stderr.write(`[roll] unknown flag: ${a}\n${HELP}`);
      return 1;
    } else if (storyId === undefined) {
      storyId = a;
    } else {
      process.stderr.write(`[roll] unexpected argument: ${a}\n${HELP}`);
      return 1;
    }
  }
  if (storyId === undefined || storyId === "") {
    process.stderr.write(`[roll] pair score requires a story id\n${HELP}`);
    return 1;
  }
  const summary = resolveSummary(storyId, flags.get("--summary"), flags.get("--file"));
  if (summary === null) {
    process.stderr.write(
      `[roll] no summary for ${storyId}: pass --summary/--file, or add the story to .roll/backlog.md\n`,
    );
    return 1;
  }
  const timeoutMs = flags.has("--timeout-ms") ? Number(flags.get("--timeout-ms")) : PAIR_SCORE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(`[roll] invalid --timeout-ms\n`);
    return 1;
  }

  // --skill overrides the prefix heuristic (codex pair-review: a design session
  // scoring a US id must not be labelled roll-build). FIX-344: --design defaults
  // the skill to roll-design (the design path's note must read scoring as a
  // roll-design Review Score, not roll-build).
  const skill =
    flags.get("--skill") ??
    (design ? "roll-design" : storyId.startsWith("FIX-") || storyId.startsWith("BUG-") ? "roll-fix" : "roll-build");
  // FIX-344: the cycle-id namespace carries the score stage so a design score's
  // session id reads `manual-design-<id>:design:...` (the runScorePairing prefix
  // adds the stage; the cycle id keeps the surfaces distinguishable on disk too).
  const cycleId = `manual-${design ? "design-" : ""}${storyId}-${Math.floor(Date.now() / 1000)}`;
  const scoreStage: "score" | "design" = design ? "design" : "score";
  // FIX-344: roll-design produces specs/backlog, not a diff — grade DESIGN quality
  // with the design prompt. The reply contract + parser are shared, so the note
  // shape is identical; only the rubric and the stage label differ.
  const buildPrompt = design ? buildDesignScorePrompt : buildPairScorePrompt;
  // US-SKILL-030: read the Evaluation contract from spec (best-effort; legacy
  // specs without the block degrade gracefully — evalContractSummary stays "").
  let evalContractSummary = "";
  if (!design) {
    try {
      const specPath = join(cardArchiveDir(process.cwd(), storyId), "spec.md");
      if (existsSync(specPath)) {
        evalContractSummary = formatEvaluationContractForScorer(parseEvaluationContract(readFileSync(specPath, "utf8")));
      }
    } catch { /* best-effort */ }
  }
  const rawArtifactAttempts = new Map<string, number>();
  const saveManualRawArtifact = (peer: string, stdout: string): string => {
    const key = `${peer}:${scoreStage}`;
    const attempt = (rawArtifactAttempts.get(key) ?? 0) + 1;
    rawArtifactAttempts.set(key, attempt);
    return writeManualScoreRawArtifact(process.cwd(), cycleId, peer, scoreStage, attempt, stdout);
  };
  const scorePeer = async (peer: string, s: string, t: number) => {
    const prompt = design ? (buildDesignScorePrompt as (s: string) => string)(s) : buildPairScorePrompt(s, evalContractSummary || undefined);
    const res = await deps.spawnReviewer({ agent: peer, projectPath: process.cwd(), prompt, timeoutMs: t });
    if (res.status !== "ok") {
      const artifactPath = res.stdout.trim() !== "" ? saveManualRawArtifact(peer, res.stdout) : undefined;
      appendPairEvent({
        type: "pair:score-failure",
        cycleId,
        peer,
        cause: res.status === "timeout" ? "timeout" : "exit-error",
        detail: res.status === "error" ? res.reason : artifactPath !== undefined ? "timeout; raw output saved" : "timeout",
        ...(artifactPath !== undefined ? { artifactPath } : {}),
        stage: scoreStage,
        ts: Date.now(),
      });
      return null;
    }
    const diag = diagnosePairScoreOutput(res.stdout);
    if (!diag.ok) {
      const artifactPath = saveManualRawArtifact(peer, res.stdout);
      appendPairEvent({
        type: "pair:score-failure",
        cycleId,
        peer,
        cause: "unparseable",
        // FIX-1045: specific reason + category instead of a generic message.
        detail:
          diag.category === "no-score-content"
            ? `no score content returned: ${diag.reason}`
            : `returned score-like text but not accepted: ${diag.reason}`,
        artifactPath,
        stage: scoreStage,
        ts: Date.now(),
      });
      return null;
    }
    return { ...diag.score, cost: peerReviewCost(peer, res.stdout) };
  };

  // --worker pins the agent that actually delivered the cycle (codex
  // pair-review: a tier-routed cycle may not match the project default, and
  // heterogeneity must be computed against the real author). For --design this
  // is the DESIGN agent: it triggers the score but NEVER scores its own output
  // (the reviewer is a fresh separate session, never the worker's session).
  const worker = flags.get("--worker") ?? deps.workingAgent();
  const r = await runScorePairing(process.cwd(), join(process.cwd(), ".roll"), cycleId, worker, storyId, skill, summary, {
    installed: deps.installed,
    isAvailable: deps.isAvailable,
    scorePeer,
    event: appendPairEvent,
    now: () => Date.now(),
    timeoutMs,
    scoreStage,
  });

  if (r.status === "scored") {
    const rel = r.notePath !== undefined ? relative(process.cwd(), r.notePath) : "";
    process.stdout.write(
      `Pair score written by ${r.peer}: ${r.score}/10\n` +
        `配对评分已由 ${r.peer} 写入：${r.score}/10\n` +
        `  ${rel}\n  evidence: ${relative(process.cwd(), join(process.cwd(), ".roll", "peer", `cycle-${cycleId}.${scoreStage}.pair.json`))}\n`,
    );
    return 0;
  }
  // FIX-343 (AC1 + step ④): the score stage is mandatory and the working agent
  // NEVER grades its own work — there is no self-grade escape. A non-scored outcome
  // (none-available / timeout / error) means NO Review Score was produced; the
  // cycle's attest gate then fails loud on "missing peer review score". This
  // command reports the honest reason and exits non-zero (no synthesized pass).
  const reason =
    r.status === "none-available"
      ? "no scorer available to spawn a fresh review session"
      : r.status === "timeout"
        ? `peer ${r.peer ?? ""} timed out or broke protocol`.trim()
        : "score pairing errored";
  process.stderr.write(
    `No Review Score produced (${reason}) — a fresh-session peer Reviewer must score this cycle; retry once a scorer is available.\n` +
      `未产出评审分（${reason}）——必须由独立新 session 的评审 agent 打分；待有可用评审后重试。\n`,
  );
  return 1;
}
