/**
 * @responsibility Selects the cheapest sufficient execution profile from risk signals.
 * US-V4-004 — pure Story execution-profile selection.
 *
 * Roll picks the CHEAPEST SUFFICIENT profile from a story's risk signals before
 * a Cycle runs (arch §6, §12):
 *   standard — builder only            (low-risk, local, clear AC, low evidence risk)
 *   verified — builder → evaluator     (user-visible / evidence risk / weak history)
 *   designed — designer → builder → eval (ambiguous / cross-module / truth-release /
 *                                        agent-runtime semantics)
 *
 * Both functions are pure (no I/O). `classifyStoryRisk` derives the risk signals
 * from a story's spec text + facts; `selectExecutionProfile` is the exact
 * decision from arch §12.
 */
import type { ExecutionProfile, StoryRiskInput } from "@roll/spec";

/**
 * The exact arch §12 decision. Planning risk (doing the WRONG work) escalates to
 * `designed`; evidence/judgment risk escalates to `verified`; otherwise `standard`.
 */
export function selectExecutionProfile(input: StoryRiskInput): ExecutionProfile {
  if (
    input.acceptanceAmbiguous ||
    input.crossModule ||
    input.touchesTruthOrRelease ||
    input.touchesAgentRuntime
  ) {
    return "designed";
  }
  if (input.userVisible || input.visualEvidenceRequired || input.historicalEvidenceRisk) {
    return "verified";
  }
  return "standard";
}

/**
 * Apply the project's `execution_policy.mode` to a classified profile to get the
 * EFFECTIVE profile that actually executes. The default mode is `standard`
 * (including no `.roll/agents.yaml`), so a project that has not opted into
 * verified/designed execution stays Builder-only — the v4.0 no-regression
 * guarantee (US-V4-004). A project opts in via `execution_policy.mode`:
 *   standard → always standard (opt-out);
 *   auto     → the classified profile;
 *   verified → floor at verified (designed still escalates);
 *   designed → always the full Designer→Builder→Evaluator pipeline.
 */
export function applyExecutionPolicy(
  classified: ExecutionProfile,
  mode: "standard" | "verified" | "designed" | "auto",
): ExecutionProfile {
  switch (mode) {
    case "standard":
      return "standard";
    case "auto":
      return classified;
    case "verified":
      return classified === "designed" ? "designed" : "verified";
    case "designed":
      return "designed";
  }
}

/** A short, human-readable rationale for the chosen profile (for the event +
 *  watch/status surfaces). Deterministic from the same input. */
export function explainExecutionProfile(input: StoryRiskInput): string {
  const designed: string[] = [];
  if (input.acceptanceAmbiguous) designed.push("ambiguous acceptance");
  if (input.crossModule) designed.push("cross-module");
  if (input.touchesTruthOrRelease) designed.push("truth/release semantics");
  if (input.touchesAgentRuntime) designed.push("agent-runtime semantics");
  if (designed.length > 0) return `designed: ${designed.join(", ")}`;
  const verified: string[] = [];
  if (input.userVisible) verified.push("user-visible");
  if (input.visualEvidenceRequired) verified.push("visual evidence required");
  if (input.historicalEvidenceRisk) verified.push("prior evidence gaps");
  if (verified.length > 0) return `verified: ${verified.join(", ")}`;
  return "standard: low-risk local work";
}

const STORY_TYPE_BY_PREFIX: ReadonlyArray<readonly [RegExp, StoryRiskInput["storyType"]]> = [
  [/^US-/i, "US"],
  [/^FIX-/i, "FIX"],
  [/^BUG-/i, "FIX"],
  [/^REFACTOR-/i, "REFACTOR"],
  [/^IDEA-/i, "IDEA"],
];

function storyTypeOf(storyId: string): StoryRiskInput["storyType"] {
  for (const [re, type] of STORY_TYPE_BY_PREFIX) if (re.test(storyId)) return type;
  return "US";
}

// Keyword heuristics — these read the story's OWN spec text, never agent output.
const USER_VISIBLE_RE = /\b(cli|help|tui|terminal|screenshot|web|ui|button|page|render|output|command|prompt)\b/i;
const TRUTH_RELEASE_RE = /\b(truth|release|consistency|attest|delivery record|deliveryrecord|reconcile|merge[- ]queue|main truth|dossier)\b/i;
const AGENT_RUNTIME_RE = /\b(agent routing|route profile|\brig\b|execution profile|spawn|runner|orchestrator|cycle\b|loop engine|scheduler)\b/i;
const CROSS_MODULE_RE = /\b(cross[- ]module|multiple packages|spec\/core\/cli|end[- ]to[- ]end flow|several (modules|files|packages))\b/i;

/** Count acceptance-criteria checkboxes in a spec; few/none → ambiguous. */
function acCount(specText: string): number {
  return (specText.match(/^\s*-\s*\[[ xX]\]/gm) ?? []).length;
}

function frontmatterHas(specText: string, key: RegExp): boolean {
  const fm = /^---\n([\s\S]*?)\n---/.exec(specText);
  return fm !== null && key.test(fm[1] ?? "");
}

/**
 * Derive {@link StoryRiskInput} from a story's spec text + a few facts. Pure +
 * heuristic — over-classifying toward verified/designed is safe (it only spends a
 * verification/planning session); the goal is to never UNDER-classify a risky
 * story to standard. `historicalEvidenceRisk` is injected by the caller (it comes
 * from prior cycle facts), defaulting false.
 */
export function classifyStoryRisk(
  storyId: string,
  specText: string,
  facts: { estimatedMinutes?: number; filesHint?: readonly string[]; historicalEvidenceRisk?: boolean } = {},
): StoryRiskInput {
  const exempt = frontmatterHas(specText, /^screenshot_exempt:/m);
  const visualEvidenceRequired =
    !exempt &&
    (/\[visual-evidence\]/i.test(specText) ||
      frontmatterHas(specText, /^physical_terminal:/m) ||
      frontmatterHas(specText, /^(deliverable_url|screenshot_url):/m));
  const userVisible =
    visualEvidenceRequired ||
    frontmatterHas(specText, /^deliverable_cmd:/m) ||
    USER_VISIBLE_RE.test(specText);
  const files = facts.filesHint ?? [];
  const crossModule =
    CROSS_MODULE_RE.test(specText) || new Set(files.map((f) => f.split("/").slice(0, 2).join("/"))).size > 1;
  return {
    storyId,
    storyType: storyTypeOf(storyId),
    ...(facts.estimatedMinutes !== undefined ? { estimatedMinutes: facts.estimatedMinutes } : {}),
    filesHint: files,
    userVisible,
    visualEvidenceRequired,
    crossModule,
    touchesTruthOrRelease: TRUTH_RELEASE_RE.test(specText),
    touchesAgentRuntime: AGENT_RUNTIME_RE.test(specText),
    acceptanceAmbiguous: acCount(specText) === 0,
    historicalEvidenceRisk: facts.historicalEvidenceRisk === true,
  };
}
