/**
 * @responsibility Runs the `roll loop review-resize` subcommand, re-splitting stories flagged too large.
 */
/**
 * `roll loop review-resize <story-id>`
 *
 * US-AGENT-041 — the reviewer-triggered self-downgrade. After a delivery is
 * scored, if the independent reviewer flagged the SCOPE as too large (a
 * `RESIZE:` signal on a LOW score — see review-resize.ts), this re-splits the
 * story instead of letting it idle as a low-confidence "done":
 *
 *   1. `$roll-design` mints sub-stories from the reviewer's enumerated gaps.
 *   2. The split PROPOSAL is reviewed by ≥2 HETEROGENEOUS agents (reusing the
 *      peer-review spawn) — all agree → auto-land; any objection → pause + alert
 *      (human on the loop, not in it; [[feedback_hetero_consensus_replaces_human_confirm]]).
 *   3. On consensus, the split is handed to `roll loop self-downgrade`
 *      (US-AGENT-042): parent → 🚫 Hold, sub-stories appended, open PR closed,
 *      `story:split` recorded. The chain-depth cap (US-AGENT-009) lives in that
 *      command — NO new counter here.
 *
 * This is the TRIGGER EDGE only: every mechanism (design, peer review,
 * self-downgrade, the cap) is reused. The deep cycle/gate path is untouched —
 * this runs POST-cycle, so a stale claim has already been released; landing the
 * split simply re-parks the parent at Hold.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EventBus,
  type ResizeSignal,
  agentVendor,
  agentsInstalled,
  canonicalAgentName,
  isHeterogeneous,
  parseResizeSignal,
  resizeConsensus,
  shouldResize,
  type ConsensusVerdict,
} from "@roll/core";
import { realAgentEnv } from "./agent-list.js";
import { agentCanReviewHeadless } from "@roll/core";
import { projectSlug } from "./dashboard.js";
import { spawnPeerReviewAgent } from "./peer.js";
import { loopSelfDowngradeCommand } from "./loop-self-downgrade.js";
import { readLatestResizeSignal } from "../lib/review-score.js";

/** The split proposal a consensus reviewer judges. */
export interface ResizeProposal {
  parentId: string;
  reason: string;
  gaps: string[];
  subIds: string[];
}

export interface ReviewResizeDeps {
  now: () => number;
  /** The latest peer score for the story + any resize signal (null = none). */
  readResize: (projectPath: string, storyId: string) => { score: number; resize: ResizeSignal | null } | null;
  /** `$roll-design` over the gaps → freshly-minted sub-story ids (specs created). */
  design: (projectPath: string, storyId: string, gaps: string[]) => Promise<string[]>;
  /** Heterogeneous reviewer candidates (distinct vendors), most-preferred first. */
  peers: (projectPath: string) => string[];
  /** One heterogeneous reviewer's verdict on the split proposal. */
  consult: (projectPath: string, peer: string, proposal: ResizeProposal) => Promise<ConsensusVerdict>;
  /** Land the split (reuse US-AGENT-042). Returns the command's exit code. */
  selfDowngrade: (storyId: string, reason: string, subIds: string[]) => Promise<number>;
  /** Escalate: write a PAUSE-worthy ALERT; the backlog is left UNCHANGED. */
  alert: (projectPath: string, message: string, ts: number) => void;
}

const CONSULT_TIMEOUT_MS = 120_000;

/** Build the prompt a heterogeneous reviewer uses to judge the split proposal. */
export function buildResizeConsensusPrompt(p: ResizeProposal): string {
  return (
    `You are an independent reviewer judging a STORY SPLIT proposal (not code). A delivery for ` +
    `${p.parentId} was scored too-big-for-one-cycle; the reviewer enumerated these uncovered gaps:\n` +
    p.gaps.map((g, i) => `  ${i + 1}. ${g}`).join("\n") +
    `\n\nThe proposed sub-stories are: ${p.subIds.join(", ")}\nReason: ${p.reason}\n\n` +
    `Judge ONLY the decomposition: do the sub-stories cover every gap, are they independent and each ` +
    `small enough for one cycle, and is there no overlap? Reply with exactly one line:\n` +
    `  AGREE   — if the split is sound\n` +
    `  OBJECT: <one line> — if a gap is uncovered, a sub-story is still too big, or they overlap\n`
  );
}

/** Parse a consensus reviewer's reply into a verdict (defaults to OBJECT if unclear). */
export function parseConsensusReply(peer: string, stdout: string): ConsensusVerdict {
  if (/^\s*OBJECT\s*:/im.test(stdout)) {
    const m = /^\s*OBJECT\s*:\s*(.+?)\s*$/im.exec(stdout);
    return { peer, agree: false, reason: (m?.[1] ?? "objection").trim() };
  }
  if (/^\s*AGREE\s*$/im.test(stdout)) return { peer, agree: true };
  // Ambiguous / no parseable verdict → treat as an objection (fail closed: a
  // reviewer that can't clearly agree must not silently pass the split).
  return { peer, agree: false, reason: "no clear AGREE/OBJECT verdict" };
}

export function realReviewResizeDeps(): ReviewResizeDeps {
  return {
    now: () => Date.now(),
    readResize: (projectPath, storyId) => readLatestResizeSignal(projectPath, storyId),
    design: async (projectPath, storyId, gaps) => {
      const installed = agentsInstalled(realAgentEnv()).map(canonicalAgentName).filter((a) => agentCanReviewHeadless(a));
      const designer = installed[0];
      if (designer === undefined) return [];
      const prompt =
        `Run the $roll-design workflow to split ${storyId} into smaller sub-stories that each address ` +
        `one of these uncovered gaps, sized for a single TCR cycle:\n` +
        gaps.map((g, i) => `  ${i + 1}. ${g}`).join("\n") +
        `\n\nFor each sub-story create its .roll/features/<epic>/<id>/spec.md. Do NOT edit the backlog. ` +
        `Output exactly one final line: SUBCARDS: <id1>,<id2>,...`;
      const r = await spawnPeerReviewAgent({ agent: designer, projectPath, prompt, timeoutMs: CONSULT_TIMEOUT_MS });
      const m = /^\s*SUBCARDS:\s*(.+?)\s*$/im.exec(r.stdout);
      if (m?.[1] === undefined) return [];
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    },
    peers: (_projectPath) => {
      // Distinct-vendor reviewers that can review headless (deterministic order).
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of agentsInstalled(realAgentEnv()).map(canonicalAgentName)) {
        if (!agentCanReviewHeadless(a)) continue;
        const vendor = agentVendor(a);
        if (seen.has(vendor)) continue;
        seen.add(vendor);
        out.push(a);
      }
      return out;
    },
    consult: async (projectPath, peer, proposal) => {
      const r = await spawnPeerReviewAgent({
        agent: peer,
        projectPath,
        prompt: buildResizeConsensusPrompt(proposal),
        timeoutMs: CONSULT_TIMEOUT_MS,
      });
      if (r.status !== "ok") return { peer, agree: false, reason: `consult ${r.status}` };
      return parseConsensusReply(peer, r.stdout);
    },
    selfDowngrade: (storyId, reason, subIds) => loopSelfDowngradeCommand([storyId, reason, subIds.join(",")]),
    alert: (projectPath, message, ts) => {
      const rt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(projectPath, ".roll", "loop");
      const alertsPath = (process.env["ROLL_LOOP_ALERT"] ?? "").trim() || join(rt, `ALERT-${projectSlug(projectPath)}.md`);
      try {
        mkdirSync(dirname(alertsPath), { recursive: true });
        appendFileSync(alertsPath, `[${new Date(ts).toISOString()}] ALERT ${message}\n`, "utf8");
      } catch {
        /* best-effort */
      }
    },
  };
}

function usage(): number {
  process.stderr.write(
    "Usage: roll loop review-resize <story-id>\n" +
      "  Reviewer-triggered re-split: if the latest peer score flagged the scope too large,\n" +
      "  design sub-stories from the gaps, gate on heterogeneous consensus, then self-downgrade.\n",
  );
  return 2;
}

export async function loopReviewResizeCommand(
  argv: string[],
  deps: ReviewResizeDeps = realReviewResizeDeps(),
): Promise<number> {
  const storyId = (argv[0] ?? "").trim();
  if (storyId === "") return usage();

  const project = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  const rt = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim() || join(project, ".roll", "loop");
  const eventsPath = join(rt, "events.ndjson");
  const bus = new EventBus();
  const ts = deps.now();

  const latest = deps.readResize(project, storyId);
  if (latest === null || !shouldResize(latest.score, latest.resize) || latest.resize === null) {
    process.stdout.write(`review-resize: ${storyId} — no scope-resize signal (nothing to do)\n`);
    return 0;
  }
  const resize = latest.resize;

  // 1. $roll-design → sub-story candidates from the gaps.
  const subIds = await deps.design(project, storyId, resize.gaps);

  // A design that can't produce ≥2 sub-stories is irreducible — hand it straight
  // to self-downgrade, which takes the cap/irreducible path (Hold + ALERT). No
  // consensus is needed to PARK an irreducible card for human triage.
  if (subIds.length < 2) {
    process.stdout.write(`review-resize: ${storyId} — design produced <2 sub-stories; parking for triage\n`);
    return await deps.selfDowngrade(storyId, `reviewer resize (irreducible): ${resize.reason}`, subIds);
  }

  const proposal: ResizeProposal = { parentId: storyId, reason: resize.reason, gaps: resize.gaps, subIds };

  // 2. Heterogeneous consensus on the split proposal (≥2 distinct vendors).
  const peers = deps.peers(project);
  const verdicts: ConsensusVerdict[] = [];
  for (const peer of peers) {
    // Stop once we have enough agreeing reviewers from distinct vendors; an
    // objection short-circuits (consensus already cannot land).
    verdicts.push(await deps.consult(project, peer, proposal));
    if (verdicts.some((v) => !v.agree)) break;
    if (verdicts.length >= 2) break;
  }
  const consensus = resizeConsensus(verdicts);

  if (!consensus.landed) {
    const msg =
      `${storyId} re-split NOT landed — heterogeneous consensus failed (${consensus.reason}). ` +
      `Proposed: ${subIds.join(", ")}. Backlog unchanged; held for human triage.`;
    deps.alert(project, msg, ts);
    bus.appendEvent(eventsPath, { type: "alert:notify", channel: "review-resize", message: msg, ts });
    process.stdout.write(`review-resize: ${storyId} — consensus FAILED (${consensus.reason}); paused + alerted, backlog unchanged\n`);
    return 0;
  }

  // 3. Consensus reached → land the split via US-AGENT-042 (it emits story:split,
  //    parks the parent, appends children, closes the open PR, enforces the cap).
  process.stdout.write(
    `review-resize: ${storyId} — consensus reached (${consensus.agreeCount}/${consensus.total} agree); landing split → ${subIds.join(", ")}\n`,
  );
  return await deps.selfDowngrade(storyId, `reviewer resize: ${resize.reason}`, subIds);
}

/** Parse a raw reviewer score reply into a resize signal (re-exported helper). */
export { parseResizeSignal };
