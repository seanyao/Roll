/**
 * US-V4-005 — the Evaluator artifact contract for `verified` (and `designed`)
 * execution: a fresh-session Evaluator role consumes the Builder's evidence via
 * artifact refs and writes `eval-report.md` + `artifact-manifest.json`.
 *
 * The Evaluator is NOT one monolithic `evaluate() → pass/fail`. It composes THREE
 * separate contracts the cycle already runs in fresh sessions — blocking review,
 * independent score, and the attest evidence gate — into a structured report.
 * This module owns the pure render/parse/validate/assemble logic; the runner
 * spawns the session and reuses the existing review/score/attest capabilities.
 *
 * Fail-closed: a missing or malformed Evaluator artifact is NOT success. A
 * verified/designed delivery whose evaluator artifact won't parse, or whose
 * session id equals the builder's (a self-grade), is rejected.
 */
import type { ArtifactManifest, EvalRecommendation, EvalReport } from "@roll/spec";

const H = {
  blocking: "## Blocking findings",
  advisory: "## Advisory findings",
  score: "## Score",
  attest: "## Attest / evidence status",
  designed: "## Design contract vs delivered",
  recommendation: "## Recommendation",
} as const;

const RECOMMENDATIONS: readonly EvalRecommendation[] = ["merge", "repair", "resize", "hold", "escalate"];

function bullets(items: readonly string[]): string {
  return items.length === 0 ? "- (none)\n" : items.map((i) => `- ${i}`).join("\n") + "\n";
}

/** Render an {@link EvalReport} to the `eval-report.md` artifact (round-trips
 *  through {@link parseEvalReport}). */
export function renderEvalReport(r: EvalReport): string {
  const parts = [
    `# Evaluator report — ${r.storyId}`,
    "",
    H.blocking,
    bullets(r.blockingFindings),
    H.advisory,
    bullets(r.advisoryFindings),
    H.score,
    r.score !== undefined ? `- ${r.score.value} (${r.score.verdict})\n` : "- (not scored)\n",
    H.attest,
    `- ${r.attestStatus}\n`,
  ];
  if (r.designContractVsDelivered !== undefined && r.designContractVsDelivered !== "") {
    parts.push(H.designed, `${r.designContractVsDelivered}\n`);
  }
  parts.push(H.recommendation, `- ${r.recommendation}\n`);
  return parts.join("\n");
}

function section(md: string, heading: string): string | null {
  const idx = md.indexOf(heading);
  if (idx < 0) return null;
  const after = md.slice(idx + heading.length);
  const next = after.search(/\n## /);
  return (next < 0 ? after : after.slice(0, next)).trim();
}

function parseBullets(body: string | null): string[] {
  if (body === null) return [];
  const items = body
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l !== "" && l.toLowerCase() !== "(none)");
  return items;
}

/**
 * Parse an `eval-report.md` back into a structured {@link EvalReport}. Returns
 * null (fail-closed signal) when the REQUIRED sections — blocking findings,
 * attest status, and a valid recommendation — are absent. The renderer's output
 * always round-trips.
 */
export function parseEvalReport(md: string, storyId: string): EvalReport | null {
  if (typeof md !== "string" || md.trim() === "") return null;
  // Required sections present?
  if (md.indexOf(H.blocking) < 0 || md.indexOf(H.attest) < 0 || md.indexOf(H.recommendation) < 0) return null;
  const recRaw = (section(md, H.recommendation) ?? "").replace(/^[-*]\s*/, "").trim().toLowerCase();
  const recommendation = RECOMMENDATIONS.find((r) => r === recRaw);
  if (recommendation === undefined) return null;
  const attestRaw = (section(md, H.attest) ?? "").replace(/^[-*]\s*/, "").trim().toLowerCase();
  const attestStatus =
    attestRaw === "produced" ? "produced" : attestRaw === "skipped" ? "skipped" : "unknown";
  const scoreBody = section(md, H.score);
  let score: EvalReport["score"];
  if (scoreBody !== null) {
    const m = /(-?\d+(?:\.\d+)?)\s*\((good|ok|regression)\)/.exec(scoreBody);
    if (m !== null) score = { value: Number(m[1]), verdict: m[2] as "good" | "ok" | "regression" };
  }
  const designed = section(md, H.designed);
  return {
    storyId,
    blockingFindings: parseBullets(section(md, H.blocking)),
    advisoryFindings: parseBullets(section(md, H.advisory)),
    ...(score !== undefined ? { score } : {}),
    attestStatus,
    ...(designed !== null && designed !== "" ? { designContractVsDelivered: designed } : {}),
    recommendation,
  };
}

/**
 * US-V4-005 — assemble the Evaluator report from the THREE separate contracts the
 * cycle already produces (blocking review, score, attest). The recommendation is
 * derived but the dimensions stay distinct in the report. A red blocking finding
 * or a `regression` score → `repair`; a skipped attest → `hold`; otherwise
 * `merge`. (Repair bounding lives in US-V4-007.)
 */
export function assembleEvalReport(input: {
  storyId: string;
  blockingFindings: readonly string[];
  advisoryFindings?: readonly string[];
  score?: { value: number; verdict: "good" | "ok" | "regression" };
  attestStatus: "produced" | "skipped" | "unknown";
  designContractVsDelivered?: string;
}): EvalReport {
  const blocking = input.blockingFindings.length > 0;
  const regression = input.score?.verdict === "regression";
  const recommendation: EvalRecommendation =
    blocking || regression ? "repair" : input.attestStatus === "skipped" ? "hold" : "merge";
  return {
    storyId: input.storyId,
    blockingFindings: input.blockingFindings,
    advisoryFindings: input.advisoryFindings ?? [],
    ...(input.score !== undefined ? { score: input.score } : {}),
    attestStatus: input.attestStatus,
    ...(input.designContractVsDelivered !== undefined && input.designContractVsDelivered !== ""
      ? { designContractVsDelivered: input.designContractVsDelivered }
      : {}),
    recommendation,
  };
}

export interface ArtifactValidation {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * US-DELTA-007 — the two eval-report shapes Roll can READ:
 *  - `authored` — a REAL Evaluator-authored Full Delta report: carries
 *    `## Inputs checked` + `## Rationale`. The ONLY shape a NEW Delta/Full Delta
 *    run may produce (an adapter-launched Evaluator writes it).
 *  - `legacy` — a historical ASSEMBLED report (the retired `writeEvaluatorArtifact`
 *    writer: `## Blocking findings` / `## Recommendation`). Kept READABLE as
 *    archived evidence — never producible again, and never accepted as a new
 *    authored evaluation.
 *  - `invalid` — neither shape parses.
 */
export type EvalReportKind = "authored" | "legacy" | "invalid";

/**
 * US-DELTA-007 — classify an `eval-report.md` WITHOUT rewriting it. Historical
 * assembled reports are recognised + explicitly labeled `legacy` so they stay
 * readable evidence; a real authored report is `authored`. This is the READER's
 * legacy allowance (AC6): no on-disk migration.
 */
export function classifyEvalReport(md: string): EvalReportKind {
  if (typeof md !== "string" || md.trim() === "") return "invalid";
  const hasInputs = /^##\s+inputs checked/im.test(md);
  const hasRationale = /^##\s+rationale/im.test(md);
  if (hasInputs && hasRationale) return "authored";
  // parseEvalReport reads the RETIRED assembled format — historical evidence.
  if (parseEvalReport(md, "legacy") !== null) return "legacy";
  return "invalid";
}

/**
 * US-DELTA-007 — the PURE report validator for a NEW Full Delta run: a report is
 * valid ONLY when it is a REAL authored evaluation (`## Inputs checked` +
 * `## Rationale`). A legacy ASSEMBLED report is recognised, labeled, and
 * REJECTED — an assembly of score/attest fields can never satisfy the Evaluator
 * requirement. `null` (no report on disk) is fail-closed.
 */
/**
 * The non-blank body lines under a `## <heading>` section (up to the next `##`
 * or EOF), excluding the heading itself. Used to reject an EMPTY required
 * section — two bare headings must not pass as a real evaluation (codex #1501 r2).
 */
function sectionBody(md: string, headingRe: RegExp): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+/.test(line)) break; // next section
    if (line.trim() !== "") body.push(line.trim());
  }
  return body;
}

export function validateAuthoredEvalReport(md: string | null): ArtifactValidation {
  if (md === null) return { ok: false, reasons: ["eval-report.md missing"] };
  const kind = classifyEvalReport(md);
  if (kind === "authored") {
    // Both required headings are present — but each must carry real content, not
    // be a bare heading (an empty section is not a genuine evaluation).
    const reasons: string[] = [];
    if (sectionBody(md, /^##\s+inputs checked/i).length === 0) reasons.push("eval-report.md '## Inputs checked' section is empty (no inputs listed)");
    if (sectionBody(md, /^##\s+rationale/i).length === 0) reasons.push("eval-report.md '## Rationale' section is empty (no reasoning)");
    return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons };
  }
  if (kind === "legacy") {
    return {
      ok: false,
      reasons: [
        "eval-report.md is a legacy ASSEMBLED report (no '## Inputs checked' / '## Rationale') — an assembled report can never satisfy the Evaluator requirement",
      ],
    };
  }
  const reasons: string[] = [];
  if (!/^##\s+inputs checked/im.test(md)) reasons.push("eval-report.md missing '## Inputs checked' section");
  if (!/^##\s+rationale/im.test(md)) reasons.push("eval-report.md missing '## Rationale' section");
  return { ok: false, reasons: reasons.length > 0 ? reasons : ["eval-report.md malformed"] };
}

/** Shape-check an {@link ArtifactManifest} read from disk (fail-closed on a
 *  missing/garbled manifest). `expectedRole` pins the role. */
export function validateArtifactManifest(
  manifest: unknown,
  expectedRole: ArtifactManifest["role"],
): ArtifactValidation {
  const reasons: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { ok: false, reasons: ["manifest missing or not an object"] };
  }
  const m = manifest as Record<string, unknown>;
  if (m["role"] !== expectedRole) reasons.push(`manifest.role !== "${expectedRole}"`);
  if (typeof m["sessionId"] !== "string" || m["sessionId"] === "") reasons.push("manifest.sessionId missing");
  if (typeof m["storyId"] !== "string" || m["storyId"] === "") reasons.push("manifest.storyId missing");
  const rig = m["rig"];
  if (typeof rig !== "object" || rig === null || typeof (rig as Record<string, unknown>)["agent"] !== "string") {
    reasons.push("manifest.rig.agent missing");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * US-V4-005 — validate the EVALUATOR artifact pair (manifest + eval-report) and
 * its INDEPENDENCE. Fail-closed:
 *   - the manifest must be a well-formed evaluator manifest;
 *   - the eval-report must parse (required sections present);
 *   - the evaluator session id must be PRESENT and DISTINCT from the builder's —
 *     the Builder's self-report can never stand in for the Evaluator verdict.
 */
export function validateEvaluatorArtifact(opts: {
  manifest: unknown;
  reportMd: string | null;
  storyId: string;
  builderSessionId: string;
}): ArtifactValidation {
  const reasons: string[] = [];
  const man = validateArtifactManifest(opts.manifest, "evaluator");
  reasons.push(...man.reasons);
  const sessionId =
    typeof opts.manifest === "object" && opts.manifest !== null
      ? (opts.manifest as Record<string, unknown>)["sessionId"]
      : undefined;
  if (typeof sessionId === "string" && sessionId !== "" && sessionId === opts.builderSessionId) {
    reasons.push("evaluator sessionId === builder sessionId (self-grade — not an independent evaluation)");
  }
  if (opts.reportMd === null || parseEvalReport(opts.reportMd, opts.storyId) === null) {
    reasons.push("eval-report.md missing or malformed");
  }
  return { ok: reasons.length === 0, reasons };
}
