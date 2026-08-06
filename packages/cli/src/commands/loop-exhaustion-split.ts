/**
 * @responsibility Runs the `roll loop exhaustion-split` subcommand, auto-splitting exhausted cards into sub-stories.
 */
/**
 * `roll loop exhaustion-split <story-id> [reason]`
 *
 * FIX-931 — agent-exhaustion auto-split (self-heal chain 3/4). After FIX-930's
 * agent rotation has exhausted every rig on a card (all gave up zero-TCR /
 * stalled), the loop used to skip-list it and wait for a human. Instead — mirror
 * US-AGENT-041 (review-resize) as a TRIGGER EDGE over the EXISTING splitter:
 * `$roll-design` mints ≥2 smaller sub-stories from the card's spec, then
 * `roll loop self-downgrade` (US-AGENT-042) parks the parent 🚫 Hold, appends the
 * children, closes the open PR, emits `story:split`, and — on cap-hit (chain
 * depth ≥ CHAIN_DEPTH_CAP) or an irreducible <2-sub split — refuses and raises an
 * ALERT for human triage. The chain-depth cap (US-AGENT-009) lives in
 * self-downgrade; this adds NO new counter, NO new splitter.
 *
 * Unlike review-resize there is NO heterogeneous-consensus gate: the exhaustion
 * signal is mechanical (every agent failed the card), so the cap/irreducible →
 * ALERT path is the safety, not a vote.
 */
import { agentCanReviewHeadless, agentsInstalled, canonicalAgentName } from "@roll/core";
import { realAgentEnv } from "./agent-list.js";
import { spawnPeerReviewAgent } from "./peer.js";
import { loopSelfDowngradeCommand } from "./loop-self-downgrade.js";

const DESIGN_TIMEOUT_MS = 120_000;

export interface ExhaustionSplitDeps {
  /** $roll-design over the card's spec → ≥2 sub-story ids (their spec.md written). */
  design: (projectPath: string, storyId: string) => Promise<string[]>;
  /** Hand the split to the EXISTING self-downgrade machine (parent Hold + children
   *  + open-PR close + story:split + cap/irreducible→ALERT). Returns its exit code. */
  selfDowngrade: (storyId: string, reason: string, subIds: string[]) => Promise<number>;
  log?: (msg: string) => void;
}

export function realExhaustionSplitDeps(): ExhaustionSplitDeps {
  return {
    design: async (projectPath, storyId) => {
      const installed = agentsInstalled(realAgentEnv()).map(canonicalAgentName).filter((a) => agentCanReviewHeadless(a));
      const designer = installed[0];
      if (designer === undefined) return [];
      const prompt =
        `Run the $roll-design workflow to split ${storyId} into 2 or more smaller INVEST sub-stories, ` +
        `each sized for a single TCR cycle — the current card is too large (every agent has failed it). ` +
        `Read its spec at .roll/features/<epic>/${storyId}/spec.md and carve it along natural seams. ` +
        `For each sub-story create its .roll/features/<epic>/<id>/spec.md. Do NOT edit the backlog. ` +
        `Output exactly one final line: SUBCARDS: <id1>,<id2>,...`;
      const r = await spawnPeerReviewAgent({ agent: designer, projectPath, prompt, timeoutMs: DESIGN_TIMEOUT_MS });
      const m = /^\s*SUBCARDS:\s*(.+?)\s*$/im.exec(r.stdout);
      if (m?.[1] === undefined) return [];
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    },
    selfDowngrade: (storyId, reason, subIds) => loopSelfDowngradeCommand([storyId, reason, subIds.join(",")]),
  };
}

function usage(): number {
  process.stderr.write(
    "Usage: roll loop exhaustion-split <story-id> [reason]\n" +
      "  Agent-exhaustion auto-split: $roll-design mints 2+ sub-stories, then self-downgrade\n" +
      "  parks the parent at Hold + appends them (cap-hit / irreducible → ALERT for triage).\n",
  );
  return 2;
}

export async function loopExhaustionSplitCommand(
  argv: string[],
  deps: ExhaustionSplitDeps = realExhaustionSplitDeps(),
): Promise<number> {
  const storyId = (argv[0] ?? "").trim();
  if (storyId === "") return usage();
  const detail = (argv[1] ?? "").trim() || "every agent exhausted on this card (zero TCR)";
  const project = (process.env["ROLL_MAIN_PROJECT"] ?? "").trim() || process.cwd();
  const log = deps.log ?? ((m: string) => void process.stdout.write(m));

  // 1. $roll-design → sub-story candidates carved from the card's spec.
  const subIds = await deps.design(project, storyId);

  // <2 sub-stories ⇒ irreducible. self-downgrade auto-takes the cap/irreducible
  // path (Hold + ALERT for human triage) — the correct fail-closed outcome (a card
  // no agent can build that also can't be split genuinely needs a human), NOT an
  // error. ≥2 ⇒ self-downgrade lands the split (and still parks Hold if the chain
  // depth cap is already hit).
  const reason = `auto-split on agent-exhaustion: ${detail}`;
  log(
    subIds.length < 2
      ? `exhaustion-split: ${storyId} — design produced <2 sub-stories; parking for triage\n`
      : `exhaustion-split: ${storyId} — landing split → ${subIds.join(", ")}\n`,
  );
  return await deps.selfDowngrade(storyId, reason, subIds);
}
