/**
 * US-CYCLE-007 — repair-round warm-start briefing.
 *
 * When a cycle is re-dispatched after evaluator findings (a REPAIR round), a
 * fresh Builder/Evaluator session otherwise re-reads the whole repository before
 * it can act — measured at ~30-40% of a cycle. This module packages the repair
 * inputs (evaluator findings + `git diff --stat` + involved files:lines +
 * design-contract references) into a single CHECKSUMMED briefing artifact that
 * becomes the fresh session's SOLE context entry point, prefixed with an explicit
 * "start from these findings; do NOT re-explore the whole repository" instruction.
 *
 * Two invariants make the briefing safe to feed straight into a prompt:
 *   1. It rides the SAME digest discipline as the v2 Delta artifact protocol —
 *      {@link computeArtifactSha256} is the one and only digest scheme, and
 *      {@link buildRepairBriefingManifest} emits a real `DeltaArtifactManifest`
 *      (schemaVersion 2) whose single output carries the briefing's sha256, so
 *      {@link validateDeltaManifest}/`validateDigests` can verify it.
 *   2. It is BUDGETED: the whole briefing is hard-capped at a char budget so it
 *      can never itself become a context-bloat source. When content exceeds the
 *      budget the findings (the largest, most variable section) are truncated and
 *      the truncation is DECLARED IN THE HEADER — what was cut and where the full
 *      text lives — so nothing is silently dropped.
 *
 * PURE + I/O-free so the runner can unit-test packaging without a real cycle; the
 * runner (spawn-agent-handler / repair-briefing-handler) gathers the inputs and
 * writes the artifact + manifest to disk.
 */
import type {
  ArtifactRef,
  DelegationTrigger,
  DeliveryTopology,
  DeltaArtifactManifest,
  DeltaRole,
  QualityProfile,
} from "@roll/spec";
import { computeArtifactSha256 } from "../delta-team/artifact-protocol.js";

/** Default context budget (chars) for a repair briefing. Kept small: the briefing
 *  is an ORIENTATION artifact, never a repo dump — the full findings stay on disk
 *  and are cited when truncated. */
export const DEFAULT_REPAIR_BRIEFING_MAX_CHARS = 6000;

/**
 * The MINIMUM budget a briefing is allowed to run with. The instruction header +
 * a truncation declaration + a body pointer is ~700-800 chars for typical inputs;
 * below this a budget could only be honored by slicing the header (dropping the
 * required truncation declaration), so {@link buildRepairBriefing} CLAMPS any
 * smaller request UP to this floor. Chosen with headroom over the header frame.
 */
export const MIN_REPAIR_BRIEFING_MAX_CHARS = 900;

/**
 * The explicit warm-start instruction that ALWAYS leads a repair briefing. It is
 * the whole point of the artifact: the fresh session starts from the findings +
 * the changed files + the contract, and does NOT burn time re-exploring the tree.
 * It also carries the fix-forward branch discipline (the runner owns the branch),
 * so the briefing fully replaces the older low-score fix-forward prompt.
 */
export const REPAIR_BRIEFING_INSTRUCTION =
  "START FROM THESE FINDINGS — do NOT re-explore the whole repository. " +
  "The evaluator's findings, the changed files (with line numbers), and the design contract below are your SOLE entry point for this repair round. " +
  "Fix each finding with minimal, targeted edits in the runner-provided worktree; do NOT create, checkout, rename, or switch branches (the runner owns branch lifecycle). " +
  "Add or update a regression test for each fix, then re-submit for evaluation.";

/** A file involved in the cycle's changes, with the line numbers/ranges of note. */
export interface RepairBriefingFile {
  readonly path: string;
  /** Line numbers or ranges (e.g. `12`, `"40-52"`). Empty ⇒ file-level only. */
  readonly lines?: readonly (number | string)[];
}

/** The raw inputs a repair briefing is packaged from. */
export interface RepairBriefingInput {
  readonly storyId: string;
  /** 1-based repair round index (how many repair re-dispatches so far). */
  readonly round: number;
  /** Evaluator findings FULL text (eval-report.md body / reviewer rationale). */
  readonly findings: string;
  /** `git diff --stat` of the cycle's changes. */
  readonly diffStat: string;
  /** Files involved in the change, with line numbers. */
  readonly involvedFiles: readonly RepairBriefingFile[];
  /** Design-contract references (spec path, design_plan path, anchors). */
  readonly contractRefs: readonly string[];
  /**
   * On-disk path to the FULL findings, cited in the truncation marker so the
   * builder can read the complete text when the budget truncates the findings.
   */
  readonly fullFindingsPath: string;
}

/** The context budget cap. */
export interface RepairBriefingBudget {
  readonly maxChars: number;
}

/** Explicit, traceable record of what the budget truncated and where the full
 *  text lives. Declared in the briefing header, never silent. */
export interface RepairBriefingTruncation {
  /** Which section was cut. `findings` is the normal target; `whole` is the
   *  defensive hard-cap when even the fixed frame exceeds the budget. */
  readonly section: "findings" | "whole";
  readonly keptChars: number;
  readonly totalChars: number;
  /** Where the untruncated source lives (the full findings on disk). */
  readonly fullTextPath: string;
}

/** A packaged repair briefing: the prompt-ready content plus its checksum. */
export interface RepairBriefing {
  /** The full briefing markdown, GUARANTEED ≤ the budget's `maxChars`. */
  readonly content: string;
  /** sha256 of `content` (same scheme as the v2 artifact protocol). */
  readonly sha256: string;
  /** Byte length of `content` (utf8). */
  readonly bytes: number;
  /** True when the budget forced a truncation. */
  readonly truncated: boolean;
  /** Present iff `truncated` — the explicit strategy declaration. */
  readonly truncation?: RepairBriefingTruncation;
}

function renderFiles(files: readonly RepairBriefingFile[]): string {
  if (files.length === 0) return "(no changed files recorded)";
  return files
    .map((f) => {
      const lines = (f.lines ?? []).map((l) => String(l)).filter((s) => s !== "");
      return lines.length === 0 ? `- ${f.path}` : `- ${f.path}:${lines.join(",")}`;
    })
    .join("\n");
}

function renderContractRefs(refs: readonly string[]): string {
  const clean = refs.map((r) => r.trim()).filter((r) => r !== "");
  return clean.length === 0 ? "(none recorded)" : clean.map((r) => `- ${r}`).join("\n");
}

function renderHeader(input: RepairBriefingInput, truncation?: RepairBriefingTruncation): string {
  const lines = [`# Repair briefing — ${input.storyId} (repair round ${input.round})`, "", REPAIR_BRIEFING_INSTRUCTION];
  if (truncation !== undefined) {
    lines.push(
      "",
      `> ⚠️ CONTEXT-BUDGET TRUNCATION — the "${truncation.section}" section was truncated to ` +
        `${truncation.keptChars} of ${truncation.totalChars} chars. Full text: ${truncation.fullTextPath}`,
    );
  }
  return lines.join("\n");
}

/** The sections OTHER than the header, parameterized on the (possibly truncated)
 *  findings body so the budget math can size the fixed frame independently. */
function renderBody(input: RepairBriefingInput, findingsBody: string): string {
  const diff = input.diffStat.trimEnd();
  return [
    "## Evaluator findings",
    "",
    findingsBody === "" ? "(no findings text)" : findingsBody,
    "",
    "## Changes (git diff --stat)",
    "",
    "```",
    diff === "" ? "(no diff stat available)" : diff,
    "```",
    "",
    "## Involved files (path:lines)",
    "",
    renderFiles(input.involvedFiles),
    "",
    "## Design-contract references",
    "",
    renderContractRefs(input.contractRefs),
    "",
  ].join("\n");
}

function finalize(content: string, truncation: RepairBriefingTruncation | undefined): RepairBriefing {
  return {
    content,
    sha256: computeArtifactSha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: truncation !== undefined,
    ...(truncation !== undefined ? { truncation } : {}),
  };
}

/**
 * Package the repair inputs into a budgeted, checksummed briefing.
 *
 * Budget strategy (deterministic + explicit):
 *   - If the FULL briefing fits the budget → no truncation.
 *   - Else truncate the FINDINGS (largest, most variable section) to the room left
 *     after the fixed frame + a truncation marker, and DECLARE it in the header
 *     (`section: findings`, kept/total chars, path to the full text).
 *   - Defensive hard-cap: if even the fixed frame (diff-stat/files/contracts) plus
 *     the header exceeds the budget, truncate the BODY (never the header) and
 *     declare `section: whole`.
 *
 * HEADER INVARIANT: the header + its truncation declaration ALWAYS survive intact
 * — a sliced header would drop the required explicit/traceable declaration. The
 * requested budget is therefore CLAMPED UP to {@link MIN_REPAIR_BRIEFING_MAX_CHARS}
 * (and, defensively, to whatever THIS input's header itself needs), so `content`
 * is ≤ that effective budget, never a header fragment. A caller passing a tiny or
 * zero `maxChars` gets a valid header-only briefing that points at the full text,
 * not a truncated header.
 */
export function buildRepairBriefing(
  input: RepairBriefingInput,
  budget: RepairBriefingBudget = { maxChars: DEFAULT_REPAIR_BRIEFING_MAX_CHARS },
): RepairBriefing {
  const findings = input.findings ?? "";
  // Clamp UP to the floor: a budget below the header/declaration frame cannot
  // yield a valid briefing without slicing the header. Never go below the floor.
  const max = Math.max(budget.maxChars, MIN_REPAIR_BRIEFING_MAX_CHARS);

  // 1) Try the full briefing.
  const full = `${renderHeader(input)}\n\n${renderBody(input, findings)}`;
  if (full.length <= max) return finalize(full, undefined);

  // 2) Over budget → truncate the FINDINGS (largest, most variable section). Size
  //    the fixed frame with an EMPTY findings body plus a header carrying a
  //    truncation declaration whose numbers are widened to the total (an upper
  //    bound on the eventual kept-digits), so the final content can only be
  //    SHORTER than this sizing frame.
  const marker = `\n…[findings truncated — full text at ${input.fullFindingsPath}]`;
  const sizing: RepairBriefingTruncation = {
    section: "findings",
    keptChars: findings.length,
    totalChars: findings.length,
    fullTextPath: input.fullFindingsPath,
  };
  const frame = `${renderHeader(input, sizing)}\n\n${renderBody(input, "")}`;
  const room = max - frame.length - marker.length;
  if (room >= 0) {
    const truncatedFindings = findings.slice(0, room);
    const truncation: RepairBriefingTruncation = {
      section: "findings",
      keptChars: truncatedFindings.length,
      totalChars: findings.length,
      fullTextPath: input.fullFindingsPath,
    };
    // content ≤ frame length (header(truncation) ≤ header(sizing) since keptChars ≤
    // totalChars ⇒ ≤ digits), so it stays within `max`.
    const content = `${renderHeader(input, truncation)}\n\n${renderBody(input, `${truncatedFindings}${marker}`)}`;
    return finalize(content, truncation);
  }

  // 3) The fixed frame ALONE exceeds the budget (large diff-stat/file list). The
  //    HEADER + its declaration survive intact; only the BODY is truncated, with a
  //    pointer to the full text. Never slice the header — if the header itself is
  //    larger than `max` (a pathologically long path), the body room is 0 and the
  //    content is the header + pointer (slightly over `max`, but the declaration is
  //    preserved), honoring the header invariant over a hard byte cap.
  const wholeTrunc: RepairBriefingTruncation = {
    section: "whole",
    keptChars: 0,
    totalChars: findings.length,
    fullTextPath: input.fullFindingsPath,
  };
  const header = renderHeader(input, wholeTrunc);
  const hardMarker = `\n…[briefing body hard-truncated — full findings at ${input.fullFindingsPath}]`;
  const body = renderBody(input, "");
  const bodyRoom = Math.max(0, max - header.length - 2 - hardMarker.length);
  const content = `${header}\n\n${body.slice(0, bodyRoom)}${hardMarker}`;
  return finalize(content, wholeTrunc);
}

/**
 * Parse a unified `git diff` into involved files with the NEW-side line ranges of
 * each hunk (`@@ -a,b +c,d @@` → `c-(c+d-1)`). Pure + tolerant: a malformed hunk
 * header is skipped. Feeds {@link RepairBriefingInput.involvedFiles} so the runner
 * doesn't hand-roll diff parsing. Bounded by `maxFiles`.
 */
export function parseInvolvedFilesFromDiff(diff: string, maxFiles = 40): RepairBriefingFile[] {
  const out: RepairBriefingFile[] = [];
  let current: { path: string; lines: string[] } | undefined;
  for (const line of diff.split("\n")) {
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus !== null) {
      if (current !== undefined) out.push({ path: current.path, lines: current.lines });
      current = { path: (plus[1] ?? "").trim(), lines: [] };
      continue;
    }
    if (current === undefined) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (Number.isFinite(start) && Number.isFinite(count)) {
        current.lines.push(count <= 1 ? `${start}` : `${start}-${start + count - 1}`);
      }
    }
  }
  if (current !== undefined) out.push({ path: current.path, lines: current.lines });
  return out
    .filter((f) => f.path !== "" && f.path !== "/dev/null")
    .slice(0, maxFiles)
    .map((f) => ({ path: f.path, ...((f.lines ?? []).length > 0 ? { lines: f.lines } : {}) }));
}

/** Identity/provenance fields the manifest needs, supplied by the runner. */
export interface RepairBriefingManifestParams {
  readonly storyId: string;
  readonly cycleId?: string;
  readonly delegationId: string;
  readonly hostId: string;
  readonly roleInstanceId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly adapter: string;
  readonly qualityProfile: QualityProfile;
  readonly trigger?: DelegationTrigger;
  readonly topology?: DeliveryTopology;
  /**
   * Manifest role. The briefing is a READ-ONLY packaging of the evaluator's
   * findings that becomes the next builder's input; `evaluator` (read-only access)
   * is the honest default and passes {@link validateRoleAccess}. A `builder` role
   * would demand `builder-write`, which the briefing does not need.
   */
  readonly role?: Extract<DeltaRole, "evaluator" | "peer">;
  /** Path (within the delegation evidence dir) the briefing is written to. */
  readonly artifactPath: string;
  /** The briefing produced by {@link buildRepairBriefing} (for its sha256). */
  readonly briefing: RepairBriefing;
  readonly createdAt: string;
  /** Provenance inputs the briefing was distilled from (findings/diff refs). */
  readonly inputs?: readonly ArtifactRef[];
}

/** The briefing artifact, as a v2 `ArtifactRef` carrying its sha256. */
export function repairBriefingArtifactRef(artifactPath: string, briefing: RepairBriefing): ArtifactRef {
  return { path: artifactPath, sha256: briefing.sha256, kind: "report" };
}

/**
 * Build a v2 `DeltaArtifactManifest` recording the repair briefing as its single
 * output, carrying the briefing's sha256. Reuses the EXISTING manifest shape +
 * digest discipline (no parallel scheme): `validateDeltaManifest`/`validateDigests`
 * verify it. Read-only role/access — the briefing packages findings, it never
 * writes product code.
 */
export function buildRepairBriefingManifest(p: RepairBriefingManifestParams): DeltaArtifactManifest {
  return {
    schemaVersion: 2,
    delegationId: p.delegationId,
    storyId: p.storyId,
    ...(p.cycleId !== undefined ? { cycleId: p.cycleId } : {}),
    role: p.role ?? "evaluator",
    trigger: p.trigger ?? "loop-autonomous",
    topology: p.topology ?? "full-delta-team",
    qualityProfile: p.qualityProfile,
    executionIdentity: {
      kind: "roll-adapter",
      hostId: p.hostId,
      roleInstanceId: p.roleInstanceId,
      modelId: p.modelId,
      adapter: p.adapter,
    },
    sessionId: p.sessionId,
    worktreeAccess: "read-only",
    inputs: p.inputs ?? [],
    outputs: [repairBriefingArtifactRef(p.artifactPath, p.briefing)],
    createdAt: p.createdAt,
  };
}
