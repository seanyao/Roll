/**
 * @responsibility Parses the evaluation contract block from story specs.
 */
/**
 * US-SKILL-030 — Evaluation contract block parser.
 *
 * Parses the `**Evaluation contract:**` block from story spec.md text, yielding
 * structured expected_evidence and scorer_focus fields that builder and
 * evaluator consume as a shared artifact contract (no three-agent chat needed).
 *
 * The block is authored by roll-design, consumed by:
 *   - roll-build / roll-fix (read before coding, map delivered evidence back)
 *   - the peer Review Score prompt (include in scorer summary)
 *   - attest report (surface design-contract-vs-delivered evidence mapping)
 *
 * Legacy specs (no block) → null (graceful degradation, no behavior change).
 * Genuinely trivial/internal stories may carry a one-item minimal block.
 */
export interface EvaluationEvidenceItem {
  kind: "test" | "command" | "screenshot" | "document" | "diff" | "ci" | "manual" | "external-smoke" | "owner-attested" | string;
  /** File, command, surface, or report expected to prove an AC. */
  target: string;
  /** AC id (e.g. "AC1") or short AC phrase this evidence proves. */
  proves: string;
  /** US-ATTEST-015 — outward verification declaration when kind is external-smoke or owner-attested. */
  outward?: import("@roll/spec").OutwardVerificationDeclaration;
}

export interface EvaluationContract {
  evidence_mode?: EvidenceMode;
  expected_evidence: EvaluationEvidenceItem[];
  scorer_focus: string[];
  builder_notes: string[];
}

export type EvidenceMode = "visual_ui" | "cli_output" | "refactor_contract" | "data_state" | "docs_content";

export type EvidenceModeSource = "frontmatter" | "evaluation_contract" | "derived";

export interface EvidenceModeMatrix {
  mode: EvidenceMode;
  label: string;
  requiredEvidence: string[];
  screenshotPolicy: "required" | "conditional" | "not_required";
  screenshotEscalation: string[];
}

export interface EvidenceModeDecision {
  mode: EvidenceMode;
  source: EvidenceModeSource;
  matrix: EvidenceModeMatrix;
  reason: string;
}

export const EVIDENCE_MODE_MATRIX: Record<EvidenceMode, EvidenceModeMatrix> = {
  visual_ui: {
    mode: "visual_ui",
    label: "Visual UI",
    requiredEvidence: ["rendered visual capture", "functional test or smoke check", "CI"],
    screenshotPolicy: "required",
    screenshotEscalation: ["visual surface changed", "AC explicitly requests visual evidence", "layout/rendering risk exposed"],
  },
  cli_output: {
    mode: "cli_output",
    label: "CLI/output",
    requiredEvidence: ["stdout/stderr snapshot", "exit code", "command fixture or focused test", "CI"],
    screenshotPolicy: "conditional",
    screenshotEscalation: ["terminal/TUI visual surface changed", "AC explicitly requests visual evidence", "rendering/layout risk exposed"],
  },
  refactor_contract: {
    mode: "refactor_contract",
    label: "Refactor/contract",
    requiredEvidence: ["focused tests", "typecheck/build", "grep/no-old-symbol check", "CI"],
    screenshotPolicy: "not_required",
    screenshotEscalation: ["visual surface changed", "AC explicitly requests visual evidence", "rendering/layout risk exposed"],
  },
  data_state: {
    mode: "data_state",
    label: "Data/state",
    requiredEvidence: ["fixture replay", "event/assertion checks", "idempotency/concurrency coverage", "CI"],
    screenshotPolicy: "not_required",
    screenshotEscalation: ["visual surface changed", "AC explicitly requests visual evidence", "rendering/layout risk exposed"],
  },
  docs_content: {
    mode: "docs_content",
    label: "Docs/content",
    requiredEvidence: ["rendered text check", "link check", "diff review", "CI"],
    screenshotPolicy: "conditional",
    screenshotEscalation: ["layout changed", "AC explicitly requests visual evidence", "rendering/layout risk exposed"],
  },
};

/** Section header that marks the start of the evaluation contract block. */
const EVAL_CONTRACT_HEADER = /^\*\*Evaluation contract:\*\*\s*$/;

/** US-ATTEST-015 — temporary holder for outward fields during parse. */
interface OutwardParseTemp {
  _mode: "external-smoke" | "owner-attested";
  _command?: string;
  _environment?: string;
  _timeoutSec?: string;
  _reason?: string;
  _approvalRef?: string;
  _scope?: string;
  _expiresAt?: string;
}

/** Recognise a kind value as one of the known evidence kinds (case-insensitive). */
function normKind(raw: string): string {
  const k = raw.trim();
  const known = new Set(["test", "command", "screenshot", "document", "diff", "ci", "manual", "external-smoke", "owner-attested"]);
  return known.has(k) ? k : k;
}

export function parseEvidenceMode(raw: string | undefined): EvidenceMode | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  return Object.prototype.hasOwnProperty.call(EVIDENCE_MODE_MATRIX, value) ? (value as EvidenceMode) : null;
}

function frontmatterValue(specText: string, key: string): string | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(specText);
  if (fm === null) return undefined;
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = re.exec(fm[1] ?? "");
  return m?.[1]?.replace(/^['"]|['"]$/g, "").trim();
}

function specHasVisualSignal(specText: string): boolean {
  return specText
    .split(/\r?\n/)
    .some((line) => /^\s*-\s*\[[ xX]?\]/.test(line) && /\[visual-evidence\]|\bscreenshot\b|\bscreen shot\b|截图|截屏|视觉证据/i.test(line));
}

function deriveEvidenceMode(specText: string, contract: EvaluationContract | null): EvidenceMode {
  const evidenceKinds = new Set((contract?.expected_evidence ?? []).map((item) => item.kind.toLowerCase()));
  const text = specText.toLowerCase();
  if (frontmatterValue(specText, "deliverable_url") !== undefined || frontmatterValue(specText, "screenshot_url") !== undefined || evidenceKinds.has("screenshot")) {
    return "visual_ui";
  }
  if (frontmatterValue(specText, "deliverable_cmd") !== undefined || /^physical_terminal:/m.test(specText) || evidenceKinds.has("command")) {
    return "cli_output";
  }
  if (evidenceKinds.has("document") || /\bdocs?\b|documentation|guide|readme|link check|rendered text/.test(text)) {
    return "docs_content";
  }
  if (/\bdata\b|migration|fixture|event|idempotenc|concurrenc|state/.test(text)) {
    return "data_state";
  }
  return "refactor_contract";
}

export function evidenceModeForSpec(specText: string, contract: EvaluationContract | null = parseEvaluationContract(specText)): EvidenceModeDecision {
  const fromFrontmatter = parseEvidenceMode(frontmatterValue(specText, "evidence_mode"));
  if (fromFrontmatter !== null) {
    return {
      mode: fromFrontmatter,
      source: "frontmatter",
      matrix: EVIDENCE_MODE_MATRIX[fromFrontmatter],
      reason: "declared by frontmatter evidence_mode",
    };
  }
  if (contract?.evidence_mode !== undefined) {
    return {
      mode: contract.evidence_mode,
      source: "evaluation_contract",
      matrix: EVIDENCE_MODE_MATRIX[contract.evidence_mode],
      reason: "declared by Evaluation contract evidence_mode",
    };
  }
  const derived = deriveEvidenceMode(specText, contract);
  return {
    mode: derived,
    source: "derived",
    matrix: EVIDENCE_MODE_MATRIX[derived],
    reason: "derived from declared surfaces, expected evidence, and spec text",
  };
}

export function evidenceModeExemptsScreenshot(specText: string, decision: EvidenceModeDecision = evidenceModeForSpec(specText)): boolean {
  if (decision.source === "derived") return false;
  if (decision.matrix.screenshotPolicy === "required") return false;
  if (frontmatterValue(specText, "deliverable_url") !== undefined || frontmatterValue(specText, "screenshot_url") !== undefined) return false;
  if (frontmatterValue(specText, "deliverable_cmd") !== undefined || /^physical_terminal:/m.test(specText)) return false;
  if (specHasVisualSignal(specText)) return false;
  return decision.matrix.screenshotPolicy === "not_required" || decision.matrix.screenshotPolicy === "conditional";
}

export function screenshotEscalationReason(
  mode: EvidenceMode,
  input: { visualSurfaceChanged?: boolean; acRequestsVisualEvidence?: boolean; renderingRisk?: boolean },
): string | null {
  if (mode === "visual_ui") return "visual_ui evidence mode requires rendered visual proof";
  if (input.visualSurfaceChanged === true) return "visual surface changed";
  if (input.acRequestsVisualEvidence === true) return "AC explicitly requests visual evidence";
  if (input.renderingRisk === true) return "prior evidence exposes rendering/layout risk";
  return null;
}

function formatEvidenceModeMatrix(mode: EvidenceMode): string {
  const matrix = EVIDENCE_MODE_MATRIX[mode];
  return `${mode} [${matrix.requiredEvidence.join("; ")}; screenshot=${matrix.screenshotPolicy}]`;
}

/**
 * Parse the `**Evaluation contract:**` block from spec text. Returns null when:
 *   - the header is absent (legacy or old spec)
 *   - the block is present but unparseable (empty / malformed)
 *
 * The block ends at the next `**` heading, an `#`/`##` heading, or end of input.
 * Nested list items (`expected_evidence:` → `- kind:` → `target:`) are parsed
 * at exactly one indentation level.
 */
export function parseEvaluationContract(specText: string): EvaluationContract | null {
  const lines = specText.split(/\r?\n/);
  // 1. Locate the header line.
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (EVAL_CONTRACT_HEADER.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  // 2. Collect the block until the next major heading or end of input.
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Stop at another `**…:**` heading or markdown heading (# / ##)
    if (/^\*\*[A-Za-z].+:\*\*\s*$/.test(line)) break;
    if (/^#{1,2}\s/.test(line)) break;
    block.push(line);
  }
  if (block.length === 0) return null;

  // 3. Parse the block line by line. The structure is:
  //    - expected_evidence:
  //      - kind: test
  //        target: …
  //        proves: …
  //    - scorer_focus:
  //      - <item>
  //    - builder_notes:
  //      - <item>
  const evidence: EvaluationEvidenceItem[] = [];
  const scorerFocus: string[] = [];
  const builderNotes: string[] = [];
  let evidenceMode: EvidenceMode | undefined;

  let section: "expected_evidence" | "scorer_focus" | "builder_notes" | null = null;
  let currentEvidence: (Partial<EvaluationEvidenceItem> & { _outward?: Partial<OutwardParseTemp> }) | null = null;

  const finalizeEvidence = (): void => {
    if (currentEvidence !== null && currentEvidence.kind !== undefined && currentEvidence.proves !== undefined) {
      const item: EvaluationEvidenceItem = {
        kind: currentEvidence.kind,
        target: currentEvidence.target ?? "",
        proves: currentEvidence.proves,
      };
      // US-ATTEST-015 — build outward declaration from parsed fields
      const ow = currentEvidence._outward;
      if (ow !== undefined && (currentEvidence.kind === "external-smoke" || currentEvidence.kind === "owner-attested")) {
        if (ow._mode === "external-smoke") {
          item.outward = {
            mode: "external-smoke",
            command: currentEvidence.target ?? ow._command ?? "",
            environment: (ow._environment as "ci" | "nightly" | "release") ?? "",
            timeoutSec: Number(ow._timeoutSec) || 0,
          };
        } else if (ow._mode === "owner-attested") {
          item.outward = {
            mode: "owner-attested",
            reason: ow._reason ?? "",
            approvalRef: ow._approvalRef ?? "",
            ...(ow._expiresAt !== undefined && ow._expiresAt !== "" ? { expiresAt: ow._expiresAt } : {}),
            ...(ow._scope !== undefined && ow._scope !== "" ? { scope: ow._scope } : {}),
          };
        }
      }
      evidence.push(item);
    }
    currentEvidence = null;
  };

  for (const raw of block) {
    const line = raw.trim();
    if (line === "") continue;

    const modeMatch = /^-\s*evidence_mode:\s*(.+)$/.exec(line);
    if (modeMatch !== null) {
      const parsed = parseEvidenceMode(modeMatch[1]);
      if (parsed !== null) evidenceMode = parsed;
      continue;
    }

    // Section headers: `- expected_evidence:` / `- scorer_focus:` / `- builder_notes:`
    const secMatch = /^-\s*(expected_evidence|scorer_focus|builder_notes):\s*$/.exec(line);
    if (secMatch !== null) {
      finalizeEvidence();
      section = secMatch[1] as "expected_evidence" | "scorer_focus" | "builder_notes";
      continue;
    }

    if (section === null) continue;

    if (section === "expected_evidence") {
      // `- kind: test` — start of a new evidence item
      const kindMatch = /^\s*-\s*kind:\s*(.+)$/.exec(line);
      if (kindMatch !== null) {
        finalizeEvidence();
        currentEvidence = { kind: normKind(kindMatch[1] ?? ""), target: "", proves: "" };
        continue;
      }
      // `  target: …` or `  proves: …`
      if (currentEvidence !== null) {
        const targetMatch = /^target:\s*(.+)$/.exec(line);
        if (targetMatch !== null) {
          currentEvidence.target = (targetMatch[1] ?? "").trim();
          continue;
        }
        const provesMatch = /^proves:\s*(.+)$/.exec(line);
        if (provesMatch !== null) {
          currentEvidence.proves = (provesMatch[1] ?? "").trim();
          continue;
        }
        // US-ATTEST-015 — outward verification fields
        if (currentEvidence.kind === "external-smoke") {
          if (currentEvidence._outward === undefined) currentEvidence._outward = { _mode: "external-smoke" };
          const envMatch = /^environment:\s*(.+)$/.exec(line);
          if (envMatch !== null) { currentEvidence._outward._environment = (envMatch[1] ?? "").trim(); continue; }
          const timeoutMatch = /^timeout_sec:\s*(.+)$/.exec(line);
          if (timeoutMatch !== null) { currentEvidence._outward._timeoutSec = (timeoutMatch[1] ?? "").trim(); continue; }
        }
        if (currentEvidence.kind === "owner-attested") {
          if (currentEvidence._outward === undefined) currentEvidence._outward = { _mode: "owner-attested" };
          const reasonMatch = /^reason:\s*(.+)$/.exec(line);
          if (reasonMatch !== null) { currentEvidence._outward._reason = (reasonMatch[1] ?? "").trim(); continue; }
          const refMatch = /^approval_ref:\s*(.+)$/.exec(line);
          if (refMatch !== null) { currentEvidence._outward._approvalRef = (refMatch[1] ?? "").trim(); continue; }
          const scopeMatch = /^scope:\s*(.+)$/.exec(line);
          if (scopeMatch !== null) { currentEvidence._outward._scope = (scopeMatch[1] ?? "").trim(); continue; }
          const expiresMatch = /^expires_at:\s*(.+)$/.exec(line);
          if (expiresMatch !== null) { currentEvidence._outward._expiresAt = (expiresMatch[1] ?? "").trim(); continue; }
        }
      }
    } else if (section === "scorer_focus") {
      const itemMatch = /^-\s*(.+)$/.exec(line);
      if (itemMatch !== null) {
        scorerFocus.push((itemMatch[1] ?? "").trim());
      }
    } else if (section === "builder_notes") {
      const itemMatch = /^-\s*(.+)$/.exec(line);
      if (itemMatch !== null) {
        builderNotes.push((itemMatch[1] ?? "").trim());
      }
    }
  }
  finalizeEvidence();

  // A contract with zero expected_evidence items is a trivial/internal story
  // that carries a minimal block. Accept it (return the contract with empty
  // arrays) rather than return null.
  return { ...(evidenceMode !== undefined ? { evidence_mode: evidenceMode } : {}), expected_evidence: evidence, scorer_focus: scorerFocus, builder_notes: builderNotes };
}

/**
 * Render the evaluation contract as a human-readable summary block for the
 * scorer prompt. Returns "" when the contract is absent.
 */
export function formatEvaluationContractForScorer(contract: EvaluationContract | null): string {
  if (contract === null) return "";
  const parts: string[] = [];
  if (contract.expected_evidence.length > 0) {
    parts.push("Design contract evidence:");
    for (const e of contract.expected_evidence) {
      parts.push(`  - ${e.kind}: ${e.target} (proves ${e.proves})`);
    }
  }
  if (contract.evidence_mode !== undefined) {
    parts.push(`Evidence mode: ${formatEvidenceModeMatrix(contract.evidence_mode)}`);
  }
  if (contract.scorer_focus.length > 0) {
    parts.push("Scorer focus:");
    for (const s of contract.scorer_focus) {
      parts.push(`  - ${s}`);
    }
  }
  if (contract.builder_notes.length > 0) {
    parts.push("Builder notes:");
    for (const n of contract.builder_notes) {
      parts.push(`  - ${n}`);
    }
  }
  return parts.join("\n");
}

/**
 * Build a design-contract-vs-delivered evidence summary from the evaluation contract
 * and the ac-map entries, for inclusion in attest/report output.
 *
 * @param contract  The parsed evaluation contract (null → empty summary).
 * @param acMapEntries  Raw ac-map entries (may be empty).
 * @returns Human-readable summary string, or "" when no contract.
 */
export function evidenceDeltaSummary(
  contract: EvaluationContract | null,
  acMapEntries: ReadonlyArray<{ ac?: string; status?: string; evidence?: Array<{ kind?: string; href?: string; textFile?: string }> }>,
): string {
  if (contract === null) return "";
  const acStatus = new Map<string, string>();
  for (const e of acMapEntries) {
    if (e.ac !== undefined && e.status !== undefined) {
      acStatus.set(e.ac, e.status);
    }
  }
  const lines: string[] = ["Design-contract-vs-delivered evidence:"];
  for (const item of contract.expected_evidence) {
    const status = acStatus.get(item.proves) ?? "missing";
    const icon = status === "pass" ? "✅" : status === "partial" ? "⚠️" : "❓";
    lines.push(`  ${icon} ${item.kind}: ${item.target} → ${item.proves} (${status})`);
  }
  return lines.join("\n");
}
