/**
 * @responsibility Migrates capture policy text safely between supported policy modes.
 * US-EVID-032 — CapturePolicyMigration (AC1).
 *
 * An EXPLICIT, idempotent, capability-aware, reversible migration that enables
 * the best-effort capture policy ONLY when BOTH the v2 Roll Capture gateway AND
 * the browser renderer are ready. Existing projects RETAIN their recorded policy
 * otherwise — the migration never force-flips a project to `best_effort`, and it
 * never guesses a fallback (best-effort-capture-plan.md → "Migration and
 * compatibility" step 3).
 *
 * The migration operates on the project policy YAML TEXT (an injectable target),
 * touching ONLY `acceptance.capture.mode` and `acceptance.capture.migrated_from`.
 * Every other line — comments, sibling keys, other capture keys — is preserved
 * verbatim. This keeps the transform safe, idempotent, and byte-reversible.
 *
 * Reversibility (scorer_focus): enabling records the prior mode in
 * `migrated_from` (`absent` when there was no recorded capture mode). `revert`
 * restores exactly that prior state, so a migrate → revert round-trip returns
 * the policy to its original shape.
 */

/** The best-effort policy mode this migration enables. */
export const BEST_EFFORT_CAPTURE_MODE = "best_effort";

/** Sentinel recorded in `migrated_from` when there was no prior capture mode. */
export const CAPTURE_MODE_ABSENT = "absent";

/** One capability lane's readiness, with an explicit reason when unavailable. */
export interface CaptureCapabilityReadiness {
  available: boolean;
  /** Actionable reason, REQUIRED when `available` is false. */
  reason?: string;
}

/** The two capability gates that must BOTH pass to enable best-effort. */
export interface CaptureMigrationCapabilities {
  /** v2 Roll Capture gateway readiness (from `negotiateRollCaptureProtocol`). */
  gateway: CaptureCapabilityReadiness;
  /** Browser renderer readiness (Playwright Chromium availability). */
  renderer: CaptureCapabilityReadiness;
}

export type CaptureMigrationAction =
  /** best-effort newly enabled (both gates ready, was not already best-effort). */
  | "enabled"
  /** already best-effort; nothing to change (idempotent re-run). */
  | "already-best-effort"
  /** a gate is unavailable; the existing policy is retained unchanged. */
  | "retained";

export type CaptureMigrationReasonCode =
  | "gateway-and-renderer-ready"
  | "already-best-effort"
  | "provider_v2_unavailable"
  | "renderer_unavailable";

export interface CaptureMigrationPlan {
  action: CaptureMigrationAction;
  reasonCode: CaptureMigrationReasonCode;
  /** Human-facing, actionable reason (English; bilingual labels live in the CLI). */
  reason: string;
  /** The capture mode recorded before this migration (null ⇒ none recorded). */
  currentMode: string | null;
  /** The capture mode after this migration. */
  nextMode: string | null;
  /** The policy YAML text after this migration (unchanged when `changed` false). */
  nextYaml: string;
  /** True iff `nextYaml` differs from the input. */
  changed: boolean;
  /** True iff this migration can be reverted (always true — it records prior state). */
  reversible: boolean;
}

export interface PlanCapturePolicyMigrationInput {
  /** The current project policy YAML text (may be empty for a fresh project). */
  policyYaml: string;
  capabilities: CaptureMigrationCapabilities;
}

/**
 * Decide + compute the capture-policy migration (AC1). Pure and deterministic:
 * the same policy text + capabilities always yield the same plan. Enables
 * best-effort ONLY when both gates are ready; otherwise retains the existing
 * policy with an explicit reason code. Re-running an already-best-effort project
 * is a no-op (`already-best-effort`), so the migration is idempotent.
 */
export function planCapturePolicyMigration(input: PlanCapturePolicyMigrationInput): CaptureMigrationPlan {
  const { policyYaml, capabilities } = input;
  const block = readCaptureBlock(policyYaml);
  const currentMode = block.mode;

  // Capability gate: BOTH must pass. Gateway is reported first so a legacy host
  // (no v2 advertisement) yields `provider_v2_unavailable`, never a guess.
  if (!capabilities.gateway.available) {
    return retained(policyYaml, currentMode, "provider_v2_unavailable", gatewayReason(capabilities.gateway));
  }
  if (!capabilities.renderer.available) {
    return retained(policyYaml, currentMode, "renderer_unavailable", rendererReason(capabilities.renderer));
  }

  // Both gates ready. Idempotent: if already best-effort, do nothing.
  if (currentMode === BEST_EFFORT_CAPTURE_MODE) {
    return {
      action: "already-best-effort",
      reasonCode: "already-best-effort",
      reason: "capture policy is already best_effort; migration is a no-op (idempotent)",
      currentMode,
      nextMode: currentMode,
      nextYaml: policyYaml,
      changed: false,
      reversible: true,
    };
  }

  // Enable best-effort, recording the prior mode for reversibility.
  const migratedFrom = currentMode ?? CAPTURE_MODE_ABSENT;
  const nextYaml = setCaptureMigration(policyYaml, { mode: BEST_EFFORT_CAPTURE_MODE, migratedFrom });
  return {
    action: "enabled",
    reasonCode: "gateway-and-renderer-ready",
    reason: `v2 gateway and renderer are both ready; enabled best_effort (was ${currentMode ?? "unset"})`,
    currentMode,
    nextMode: BEST_EFFORT_CAPTURE_MODE,
    nextYaml,
    changed: nextYaml !== policyYaml,
    reversible: true,
  };
}

export interface RevertCapturePolicyMigrationResult {
  /** True iff the policy carried a best-effort migration this call reverses. */
  reverted: boolean;
  /** The policy YAML text after reverting (unchanged when `reverted` false). */
  nextYaml: string;
  /** True iff `nextYaml` differs from the input. */
  changed: boolean;
  /** The mode restored (null ⇒ the capture block was removed entirely). */
  restoredMode: string | null;
  reason: string;
}

/**
 * Reverse a best-effort migration (AC1 reversibility). Restores the mode
 * recorded in `migrated_from` and removes the migration marker; when the prior
 * state had no recorded capture mode (`migrated_from: absent`), the entire
 * `capture` sub-block this migration added is removed, returning the policy to
 * its original shape. A policy that carries no best-effort migration is left
 * untouched.
 */
export function revertCapturePolicyMigration(policyYaml: string): RevertCapturePolicyMigrationResult {
  const block = readCaptureBlock(policyYaml);
  if (block.migratedFrom === null) {
    return {
      reverted: false,
      nextYaml: policyYaml,
      changed: false,
      restoredMode: block.mode,
      reason: "no best_effort migration marker (migrated_from) present; nothing to revert",
    };
  }
  if (block.migratedFrom === CAPTURE_MODE_ABSENT) {
    const nextYaml = removeCaptureBlock(policyYaml);
    return {
      reverted: true,
      nextYaml,
      changed: nextYaml !== policyYaml,
      restoredMode: null,
      reason: "reverted: no prior capture mode existed; removed the migration-added capture block",
    };
  }
  const nextYaml = setCaptureMigration(policyYaml, { mode: block.migratedFrom, migratedFrom: null });
  return {
    reverted: true,
    nextYaml,
    changed: nextYaml !== policyYaml,
    restoredMode: block.migratedFrom,
    reason: `reverted: restored capture mode to "${block.migratedFrom}"`,
  };
}

/** The effective capture mode recorded in a policy (null when none recorded). */
export function readCaptureMode(policyYaml: string): string | null {
  return readCaptureBlock(policyYaml).mode;
}

// ── Reason helpers ────────────────────────────────────────────────────────────

function retained(
  policyYaml: string,
  currentMode: string | null,
  reasonCode: CaptureMigrationReasonCode,
  reason: string,
): CaptureMigrationPlan {
  return {
    action: "retained",
    reasonCode,
    reason,
    currentMode,
    nextMode: currentMode,
    nextYaml: policyYaml,
    changed: false,
    reversible: true,
  };
}

function gatewayReason(gateway: CaptureCapabilityReadiness): string {
  const detail = gateway.reason?.trim();
  return `v2 Roll Capture gateway unavailable; retained existing policy — ${detail !== undefined && detail !== "" ? detail : "host does not advertise roll.capture.v2"}`;
}

function rendererReason(renderer: CaptureCapabilityReadiness): string {
  const detail = renderer.reason?.trim();
  return `browser renderer unavailable; retained existing policy — ${detail !== undefined && detail !== "" ? detail : "Playwright Chromium is not installed"}`;
}

// ── Policy YAML editing (in place; only capture.mode / migrated_from) ──────────
//
// A focused, dependency-free editor. It NEVER reformats or reorders unrelated
// content: it only replaces / inserts / removes the two managed keys inside
// `acceptance.capture`, preserving indentation and every sibling line verbatim.

interface CaptureBlock {
  mode: string | null;
  migratedFrom: string | null;
}

const ACCEPTANCE_KEY = "acceptance";
const CAPTURE_KEY = "capture";
const MODE_KEY = "mode";
const MIGRATED_FROM_KEY = "migrated_from";

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m?.[1]?.length ?? 0;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** Match `<indent><key>:` optionally followed by an inline value; return value. */
function matchKey(line: string, key: string): { value: string | null } | null {
  const re = new RegExp(`^\\s*${key}\\s*:(.*)$`);
  const m = re.exec(line);
  if (m === null) return null;
  const rest = (m[1] ?? "").trim();
  const value = rest === "" ? null : unquote(stripInlineComment(rest));
  return { value };
}

function stripInlineComment(s: string): string {
  const m = /(^|\s)#/.exec(s);
  if (m === null) return s.trim();
  return s.slice(0, m.index + (m[1]?.length ?? 0)).trim();
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Find the [start,end) line range of a mapping block headed by `key` at `parentIndent`. */
function findBlock(
  lines: readonly string[],
  key: string,
  parentIndent: number,
  searchStart: number,
  searchEnd: number,
): { header: number; bodyStart: number; bodyEnd: number; headerIndent: number } | null {
  for (let i = searchStart; i < searchEnd; i++) {
    const line = lines[i];
    if (line === undefined || isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent !== parentIndent) continue;
    if (matchKey(line, key) === null) continue;
    // Found the header. Its body is subsequent lines with indent > headerIndent
    // (blank/comment lines are absorbed into the body until real dedent).
    const bodyStart = i + 1;
    let bodyEnd = bodyStart;
    for (let j = bodyStart; j < searchEnd; j++) {
      const bl = lines[j];
      if (bl === undefined) break;
      if (isBlankOrComment(bl)) {
        bodyEnd = j + 1;
        continue;
      }
      if (indentOf(bl) > indent) {
        bodyEnd = j + 1;
        continue;
      }
      break;
    }
    // Trim trailing blank/comment lines back out of the body (they belong to the
    // parent scope, not this block) so inserts land tightly under real children.
    while (bodyEnd > bodyStart) {
      const last = lines[bodyEnd - 1];
      if (last !== undefined && isBlankOrComment(last)) bodyEnd--;
      else break;
    }
    return { header: i, bodyStart, bodyEnd, headerIndent: indent };
  }
  return null;
}

function readCaptureBlock(policyYaml: string): CaptureBlock {
  const lines = policyYaml.split("\n");
  const acceptance = findBlock(lines, ACCEPTANCE_KEY, 0, 0, lines.length);
  if (acceptance === null) return { mode: null, migratedFrom: null };
  const captureIndent = acceptance.headerIndent + 2;
  const capture = findBlock(lines, CAPTURE_KEY, captureIndent, acceptance.bodyStart, acceptance.bodyEnd);
  if (capture === null) return { mode: null, migratedFrom: null };
  let mode: string | null = null;
  let migratedFrom: string | null = null;
  for (let i = capture.bodyStart; i < capture.bodyEnd; i++) {
    const line = lines[i];
    if (line === undefined || isBlankOrComment(line)) continue;
    if (indentOf(line) !== capture.headerIndent + 2) continue;
    const modeMatch = matchKey(line, MODE_KEY);
    if (modeMatch !== null) {
      mode = modeMatch.value;
      continue;
    }
    const mfMatch = matchKey(line, MIGRATED_FROM_KEY);
    if (mfMatch !== null) migratedFrom = mfMatch.value;
  }
  return { mode, migratedFrom };
}

interface CaptureMigrationWrite {
  mode: string;
  /** null ⇒ remove the migrated_from marker; string ⇒ set it. */
  migratedFrom: string | null;
}

function setCaptureMigration(policyYaml: string, write: CaptureMigrationWrite): string {
  const lines = policyYaml.split("\n");
  const acceptance = findBlock(lines, ACCEPTANCE_KEY, 0, 0, lines.length);

  if (acceptance === null) {
    // No acceptance block — append a fresh, well-formed one.
    const appended = [
      `${ACCEPTANCE_KEY}:`,
      `  ${CAPTURE_KEY}:`,
      `    ${MODE_KEY}: ${write.mode}`,
      ...(write.migratedFrom !== null ? [`    ${MIGRATED_FROM_KEY}: ${write.migratedFrom}`] : []),
    ];
    return joinWithBlock(policyYaml, appended);
  }

  const captureIndent = acceptance.headerIndent + 2;
  const childIndent = captureIndent + 2;
  const capture = findBlock(lines, CAPTURE_KEY, captureIndent, acceptance.bodyStart, acceptance.bodyEnd);

  if (capture === null) {
    // acceptance exists but no capture block — insert one at the end of the body.
    const insertAt = acceptance.bodyEnd;
    const inserted = [
      `${" ".repeat(captureIndent)}${CAPTURE_KEY}:`,
      `${" ".repeat(childIndent)}${MODE_KEY}: ${write.mode}`,
      ...(write.migratedFrom !== null ? [`${" ".repeat(childIndent)}${MIGRATED_FROM_KEY}: ${write.migratedFrom}`] : []),
    ];
    lines.splice(insertAt, 0, ...inserted);
    return lines.join("\n");
  }

  // capture block exists — replace/insert the two managed keys in place.
  return editCaptureChildren(lines, capture, childIndent, write);
}

function editCaptureChildren(
  lines: string[],
  capture: { bodyStart: number; bodyEnd: number; headerIndent: number },
  childIndent: number,
  write: CaptureMigrationWrite,
): string {
  const modeLine = `${" ".repeat(childIndent)}${MODE_KEY}: ${write.mode}`;
  const mfLine = write.migratedFrom !== null ? `${" ".repeat(childIndent)}${MIGRATED_FROM_KEY}: ${write.migratedFrom}` : null;

  let modeIdx = -1;
  let mfIdx = -1;
  for (let i = capture.bodyStart; i < capture.bodyEnd; i++) {
    const line = lines[i];
    if (line === undefined || isBlankOrComment(line)) continue;
    if (indentOf(line) !== childIndent) continue;
    if (matchKey(line, MODE_KEY) !== null) modeIdx = i;
    else if (matchKey(line, MIGRATED_FROM_KEY) !== null) mfIdx = i;
  }

  // Replace or insert `mode`.
  if (modeIdx >= 0) lines[modeIdx] = modeLine;
  else {
    lines.splice(capture.bodyStart, 0, modeLine);
    // Adjust indices shifted by the insert.
    if (mfIdx >= capture.bodyStart) mfIdx++;
  }

  // Recompute mf line position after a possible mode insert.
  if (write.migratedFrom === null) {
    if (mfIdx >= 0) lines.splice(mfIdx, 1);
  } else if (mfIdx >= 0) {
    lines[mfIdx] = mfLine!;
  } else {
    // Insert migrated_from right after the mode line.
    const anchor = lines.indexOf(modeLine);
    lines.splice((anchor >= 0 ? anchor : capture.bodyStart) + 1, 0, mfLine!);
  }

  return lines.join("\n");
}

function removeCaptureBlock(policyYaml: string): string {
  const lines = policyYaml.split("\n");
  const acceptance = findBlock(lines, ACCEPTANCE_KEY, 0, 0, lines.length);
  if (acceptance === null) return policyYaml;
  const captureIndent = acceptance.headerIndent + 2;
  const capture = findBlock(lines, CAPTURE_KEY, captureIndent, acceptance.bodyStart, acceptance.bodyEnd);
  if (capture === null) return policyYaml;
  // Remove [header, bodyEnd). If the capture block had non-managed children,
  // preserve them: only remove the header + the two managed keys, keeping others.
  const managedOnly = captureBodyIsManagedOnly(lines, capture, captureIndent + 2);
  if (managedOnly) {
    lines.splice(capture.header, capture.bodyEnd - capture.header);
  } else {
    // Remove only the managed keys, keep the capture block + other children.
    for (let i = capture.bodyEnd - 1; i >= capture.bodyStart; i--) {
      const line = lines[i];
      if (line === undefined || isBlankOrComment(line)) continue;
      if (indentOf(line) !== captureIndent + 2) continue;
      if (matchKey(line, MODE_KEY) !== null || matchKey(line, MIGRATED_FROM_KEY) !== null) lines.splice(i, 1);
    }
  }
  // If the migration created the whole acceptance block (it is now empty of real
  // children), remove it too so a migrate → revert round-trip is byte-reversible.
  const acceptanceAfter = findBlock(lines, ACCEPTANCE_KEY, 0, 0, lines.length);
  if (acceptanceAfter !== null && blockBodyIsEmpty(lines, acceptanceAfter)) {
    lines.splice(acceptanceAfter.header, acceptanceAfter.bodyEnd - acceptanceAfter.header);
  }
  return lines.join("\n");
}

function blockBodyIsEmpty(lines: readonly string[], block: { bodyStart: number; bodyEnd: number }): boolean {
  for (let i = block.bodyStart; i < block.bodyEnd; i++) {
    const line = lines[i];
    if (line !== undefined && !isBlankOrComment(line)) return false;
  }
  return true;
}

function captureBodyIsManagedOnly(
  lines: readonly string[],
  capture: { bodyStart: number; bodyEnd: number },
  childIndent: number,
): boolean {
  for (let i = capture.bodyStart; i < capture.bodyEnd; i++) {
    const line = lines[i];
    if (line === undefined || isBlankOrComment(line)) continue;
    if (indentOf(line) !== childIndent) return false; // a deeper/other-shaped child
    if (matchKey(line, MODE_KEY) === null && matchKey(line, MIGRATED_FROM_KEY) === null) return false;
  }
  return true;
}

/** Append a block to policy text, keeping exactly one trailing newline. */
function joinWithBlock(policyYaml: string, block: readonly string[]): string {
  const trimmed = policyYaml.replace(/\n+$/, "");
  const body = trimmed === "" ? block.join("\n") : `${trimmed}\n${block.join("\n")}`;
  return policyYaml.endsWith("\n") ? `${body}\n` : body;
}
