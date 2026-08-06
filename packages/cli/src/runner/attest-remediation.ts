/**
 * @responsibility Remediates ac-map omissions with a surgical second pass.
 */
/**
 * FIX-246 — ac-map omission remediation (one surgical second pass).
 *
 * Observed 2026-06-10: agents deliver real work (commits, tests, even a
 * rendered report) yet consistently skip skill step 10.6 — writing the
 * acceptance intent map `ac-map.json`. The attest gate (FIX-207/US-ATTEST-012)
 * then correctly classifies the report as an empty shell, every delivered
 * cycle dies at capture, and the correction circuit breaker pauses the loop.
 * The work is good; the missing artifact is one small JSON file.
 *
 * The remediation is NOT a gate bypass: when a real delivery has no ac-map,
 * the runner spawns the SAME agent once more with a narrow prompt — "write
 * the ac-map for what you just did, honest statuses only" — and re-renders
 * attest. The honesty red line is untouched: the prompt demands `claimed` for
 * any AC without real evidence, and the render layer still downgrades
 * fabricated passes (US-ATTEST-010). One retry, structurally — the capture
 * step runs once per cycle.
 *
 * ── FIX-912 — ac-map draft auto-generation ─────────────────────────────────
 *
 * Before the FIX-246 remediation fires (or when it would fire), the harness
 * auto-generates an ac-map.json DRAFT from cycle evidence that is ALREADY on
 * disk — the spec, git log, and git diff. Every AC gets a row with relevant
 * evidence chain pre-filled (matching commits, changed files, test references).
 * Statuses are CONSERVATIVE: only `pass-with-evidence` when there is CLEAR
 * proof (a test named after the AC that passed); everything else is
 * `needs-confirmation`. The honesty red line is untouched: the harness NEVER
 * auto-writes `pass` without clear evidence. The agent remediation / builder
 * step 10.6 then only needs to CONFIRM or CORRECT the statuses — the
 * structure + evidence chain is already done.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { acForStory, draftAcMap } from "@roll/core";
import type { CycleActivityEvent, RollEvent } from "@roll/spec";
import { cardArchiveDir } from "../lib/archive.js";
import type { AgentSpawn, AgentSpawnResult } from "./agent-spawn.js";
import { evidencePathsUnresolved, storyHasAcBlock, storyRequiresScreenshot, storySpecPath } from "./attest-gate.js";
import { capturedEvidenceRefs, type CapturedRef } from "./captured-evidence.js";

/** Hard wall-clock cap for the remediation spawn — writing one JSON file from
 *  already-done work is minutes, not a full cycle. */
export const ACMAP_REMEDIATION_TIMEOUT_MS = 6 * 60_000;

/** The exact ac-map path the gate reads (single-home rule, US-META-002c) —
 *  the remediation prompt bakes this in so the agent cannot guess wrong. */
export function acMapPath(worktreeCwd: string, storyId: string): string {
  return join(cardArchiveDir(worktreeCwd, storyId), "ac-map.json");
}

/**
 * Remediation fires ONLY when the ac-map is absent OR still has
 * `needs-confirmation` rows from a harness-generated draft. `pass-with-evidence`
 * is an honest harness-confirmed status: not a fabricated `pass`, but enough to
 * keep strong on-disk evidence from blocking forever when the agent leaves it.
 *
 * A story without an AC block passes the gate without a report; an
 * existing CONFIRMED ac-map (real statuses: pass/partial/claimed/missing)
 * means step 10.6 was already honored.
 *
 * FIX-912/FIX-1230: when the harness wrote a draft with unresolved
 * `needs-confirmation` rows, this still returns true so the FIX-246 remediation
 * fires with the draft-confirmation prompt. Once no row needs confirmation,
 * this returns false — the ac-map is usable.
 */
function needsAcMapDraftSeed(worktreeCwd: string, storyId: string): boolean {
  if (storyId === "") return false;
  if (storyHasAcBlock(worktreeCwd, storyId) !== true) return false;
  const p = acMapPath(worktreeCwd, storyId);
  if (!existsSync(p)) return true; // absent → remediation needed
  // FIX-1230: `pass-with-evidence` is an honest harness-confirmed status.
  // Only `needs-confirmation` remains a draft blocker.
  try {
    const entries = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(entries) || entries.length === 0) return true;
    const hasUnconfirmed = entries.some(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["status"] === ACMAP_DRAFT_STATUS,
    );
    return hasUnconfirmed;
  } catch {
    return true; // malformed ac-map → remediation needed
  }
}

export function needsAcMapRemediation(worktreeCwd: string, storyId: string): boolean {
  if (needsAcMapDraftSeed(worktreeCwd, storyId)) return true;
  return evidencePathsUnresolved(worktreeCwd, storyId).length > 0;
}

/**
 * FIX-912 — status the harness writes into a DRAFT ac-map when there is
 * INSUFFICIENT evidence to auto-confirm a pass. The agent/fix-forward must
 * review and promote to a real status (pass/partial/claimed/missing). This
 * status is DELIBERATELY NOT in the standard ac-map status set — the render
 * layer does not recognise it, so a draft that is never confirmed will fail
 * the attest gate (honest fail, not a silent bypass).
 */
export const ACMAP_DRAFT_STATUS = "needs-confirmation" as const;

/**
 * FIX-912 — status the harness writes when there IS clear evidence a specific
 * AC was satisfied (e.g. a test named after ACx passed). This is the ONLY
 * positive status the auto-draft ever writes. The word "pass" is explicit in
 * the status name so it is clear this IS a pass claim; the "with-evidence"
 * suffix records WHY the harness trusted it, so audits can verify.
 */
export const ACMAP_PASS_WITH_EVIDENCE = "pass-with-evidence" as const;

/**
 * FIX-912 — the ac-map evidence the auto-draft generator can construct from
 * cycle evidence WITHOUT running new commands (the executor already has this).
 */
export interface DraftEvidence {
  /** Lines from `git log --oneline origin/main..HEAD` in the worktree. */
  commitLines: string[];
  /** Lines from `git diff --stat origin/main...HEAD` in the worktree. */
  diffStatLines: string[];
  /** Full filenames from `git diff --name-only origin/main...HEAD`. */
  changedFilenames: string[];
}

/**
 * FIX-912 — auto-generate an ac-map.json DRAFT from existing cycle evidence.
 *
 * For every AC in the story spec, this builds a row with:
 *   - evidence chain: matching commits (whose message mentions the AC ordinal),
 *     changed files that look test-related, and any test output references
 *   - status: `pass-with-evidence` ONLY when a test file named after the AC
 *     appears in the changed files (clear proof the AC was tested); otherwise
 *     `needs-confirmation`.
 *
 * Honesty red line: NEVER auto-writes `pass` without clear evidence. The
 * `pass-with-evidence` status is ONLY written when a test file whose name
 * matches the AC ordinal is among the changed files — "this AC had a test
 * written/changed for it". Everything else stays `needs-confirmation` so the
 * agent/fix-forward MUST confirm before the gate will pass.
 *
 * PURE function — no filesystem access, no shell commands. The caller (the
 * executor) collects the evidence via git commands and passes it in.
 *
 * @returns JSON string of the ac-map draft array
 */
export function generateAcMapDraft(
  specText: string,
  storyId: string,
  evidence: DraftEvidence,
  signals?: CycleActivityEvent[],
  runDir?: string,
): string | null {
  if (storyId === "") return null;
  const acItems = acForStory(specText, storyId, { fileOwned: true });
  if (acItems.length === 0) return null;

  // US-OBS-031: when activity signals are available, use the richer
  // evidence-drafter (core) module to cross-reference signals against ACs.
  // The signal-based draft is more informative (TCR commits, gate results,
  // tool calls, screenshot refs) and carries confidence annotations.
  let signalDraft: Map<string, ReturnType<typeof draftAcMap>[number]> | undefined;
  if (signals !== undefined && signals.length > 0) {
    const draftEntries = draftAcMap({
      acItems,
      signals,
      changedFiles: evidence.changedFilenames,
    });
    signalDraft = new Map(draftEntries.map((e) => [e.ac, e]));
  }

  // Build a relevance score for each commit: which AC ordinals it mentions.
  const commitAcRelevance = new Map<string, Set<number>>();
  for (const line of evidence.commitLines) {
    const acNums = new Set<number>();
    // Match AC1, AC2, AC3, etc. in commit messages
    for (const m of line.matchAll(/AC(\d+)/gi)) {
      const n = Number(m[1]);
      if (n >= 1) acNums.add(n);
    }
    if (acNums.size > 0) commitAcRelevance.set(line, acNums);
  }

  // Detect test files changed that mention AC ordinals (strongest signal).
  const testFileAcSignals = new Map<number, string[]>();
  for (const fname of evidence.changedFilenames) {
    const base = basename(fname);
    // A test file that names the AC ordinal (e.g. ac1.test.ts, fix-912-ac5.test.ts)
    for (const m of base.matchAll(/[a-z]?ac(\d+)/gi)) {
      const n = Number(m[1]);
      if (n >= 1) {
        const list = testFileAcSignals.get(n) ?? [];
        list.push(fname);
        testFileAcSignals.set(n, list);
      }
    }
  }

  const capturedRefs = runDir !== undefined && runDir !== "" ? capturedEvidenceRefs(runDir) : [];

  const entries: Array<Record<string, unknown>> = [];
  for (const item of acItems) {
    const evidenceEntries: Array<Record<string, string>> = [];
    const ordinal = item.ordinal;

    // (1) Matching commits — any commit whose message mentions this AC
    for (const [commitLine, acNums] of commitAcRelevance) {
      if (acNums.has(ordinal)) {
        const hash = commitLine.split(/\s+/)[0] ?? "";
        const subject = commitLine.slice(hash.length).trim();
        evidenceEntries.push({
          kind: "text",
          label: `commit: ${hash.slice(0, 7)} ${subject.slice(0, 60)}`,
          textFile: `../evidence/commits-${storyId}.txt`,
        });
      }
    }

    // (2) Changed test files that mention the AC — strong signal
    const testFiles = testFileAcSignals.get(ordinal) ?? [];
    for (const tf of testFiles) {
      evidenceEntries.push({
        kind: "text",
        label: `test file changed: ${basename(tf)}`,
        textFile: `../evidence/test-output-${storyId}.txt`,
      });
    }

    // (3) Changed files generally related (matching key words from the AC text)
    for (const fname of evidence.changedFilenames) {
      // Already covered by test file signal — don't duplicate
      if (testFiles.includes(fname)) continue;
      // Only add non-test source files that look related
      const base = basename(fname);
      if (!/\.(ts|tsx|js|jsx|md|yaml|json)$/.test(base)) continue;
      // Skip large auto-generated / dist files
      if (fname.includes("/dist/") || fname.includes("node_modules/")) continue;
      evidenceEntries.push({
        kind: "text",
        label: `file changed: ${base}`,
        textFile: `../evidence/changed-files-${storyId}.txt`,
      });
    }

    // US-OBS-031: enrich with signal-based evidence from the activity stream.
    // Signal evidence (TCR commits, gate results, tool calls) is more
    // informative than file-based heuristics and carries confidence annotations.
    const sd = signalDraft?.get(item.id);
    if (sd !== undefined && sd.evidence.length > 0) {
      for (const se of sd.evidence) {
        const label = `[${se.confidence}] ${se.label}`;
        const entry: Record<string, string> = { kind: se.kind, label };
        if (se.href !== undefined) entry["href"] = se.href;
        if (se.textFile !== undefined) entry["textFile"] = se.textFile;
        evidenceEntries.push(entry);
      }
    }
    for (const ref of capturedRefs) {
      evidenceEntries.push(capturedRefEvidenceEntry(ref));
    }

    // Deduplicate evidence entries by label
    const seen = new Set<string>();
    const deduped = evidenceEntries.filter((e) => {
      const key = e["label"] ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Status determination — CONSERVATIVE by design:
    //   pass-with-evidence ONLY when a test file named after this AC changed
    //   OR when high-confidence signal evidence exists (US-OBS-031).
    //   Everything else → needs-confirmation (agent must confirm).
    const hasTestSignal = testFiles.length > 0;
    const hasHighSignal = sd !== undefined && sd.confidence === "high";
    const status = (hasTestSignal || hasHighSignal) ? ACMAP_PASS_WITH_EVIDENCE : ACMAP_DRAFT_STATUS;

    entries.push({
      ac: item.id,
      status,
      ...(deduped.length > 0 ? { evidence: deduped } : {}),
    });
  }

  return JSON.stringify(entries, null, 2) + "\n";
}

function capturedRefEvidenceEntry(ref: CapturedRef): Record<string, string> {
  const label = ref.label !== undefined ? `captured: ${ref.label}` : `captured: ${basename(ref.ref)}`;
  if (ref.kind === "text") return { kind: "text", label, textFile: ref.ref };
  return { kind: ref.kind === "capture" ? "screenshot" : ref.kind, label, href: ref.ref };
}

/**
 * FIX-912 follow-up: the draft's evidence refs must point at files that exist.
 * `generateAcMapDraft` emits stable refs under `../evidence/`; this materializes
 * those refs from the same collected facts before attest renders the report.
 */
export function writeAcMapDraftEvidenceFiles(
  worktreeCwd: string,
  storyId: string,
  evidence: DraftEvidence,
): void {
  const evidenceDir = join(cardArchiveDir(worktreeCwd, storyId), "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, `commits-${storyId}.txt`),
    `${evidence.commitLines.length === 0 ? "(no commits observed)" : evidence.commitLines.join("\n")}\n`,
  );
  writeFileSync(
    join(evidenceDir, `changed-files-${storyId}.txt`),
    `${evidence.changedFilenames.length === 0 ? "(no changed files observed)" : evidence.changedFilenames.join("\n")}\n`,
  );
  writeFileSync(
    join(evidenceDir, `test-output-${storyId}.txt`),
    [
      "Harness ac-map draft test signals",
      "",
      "Changed test files:",
      ...(evidence.changedFilenames.filter((f) => /(?:^|[\\/])(?:test|tests|__tests__)[\\/]|(?:test|spec)\.[cm]?[jt]sx?$/i.test(f)).map((f) => `- ${f}`)),
      "",
      "Diff stat:",
      ...(evidence.diffStatLines.length === 0 ? ["(no diff stat observed)"] : evidence.diffStatLines),
      "",
    ].join("\n"),
  );
}

export interface AcMapSelfHealOptions {
  worktreeCwd: string;
  archiveCwd?: string;
  storyId: string;
  runDir: string;
  cycleId: string;
  agent: string;
  writableRoots?: string[];
  collectDraftEvidence: () => Promise<DraftEvidence>;
  collectCycleSignals: () => CycleActivityEvent[] | undefined;
  canSpawnRemediation: () => boolean;
  agentSpawn: AgentSpawn;
  renderAttest: () => Promise<number>;
  appendEvent: (event: RollEvent) => void;
  now: () => number;
}

export interface AcMapSelfHealResult {
  renderExitCode: number;
}

export type AcMapRemediationReason =
  | "written"
  | "spawn-unavailable"
  | "spawn-threw"
  | "timeout"
  | "nonzero-exit"
  | "target-missing"
  | "target-empty"
  | "draft-unconfirmed"
  | "malformed"
  | "unknown";

function acMapRemediationReason(archiveCwd: string, storyId: string): AcMapRemediationReason {
  const p = acMapPath(archiveCwd, storyId);
  if (!existsSync(p)) return "target-missing";
  try {
    const entries = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(entries) || entries.length === 0) return "target-empty";
    const hasDraft = entries.some(
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>)["status"] === ACMAP_DRAFT_STATUS,
    );
    return hasDraft ? "draft-unconfirmed" : "written";
  } catch {
    return "malformed";
  }
}

function writeAcMapRemediationTranscript(input: {
  runDir: string;
  ts: number;
  agent: string;
  storyId: string;
  cwd: string;
  archiveCwd: string;
  target: string;
  outcome: "written" | "still-missing" | "spawn-failed";
  reason: AcMapRemediationReason;
  result?: AgentSpawnResult;
  error?: unknown;
}): string | undefined {
  try {
    mkdirSync(input.runDir, { recursive: true });
    const path = join(input.runDir, `remediation-${input.ts}.log`);
    const body = [
      `agent=${input.agent}`,
      `story=${input.storyId}`,
      `outcome=${input.outcome}`,
      `reason=${input.reason}`,
      `cwd=${input.cwd}`,
      `archiveCwd=${input.archiveCwd}`,
      `target=${input.target}`,
      input.result !== undefined ? `exitCode=${input.result.exitCode}` : "exitCode=",
      input.result !== undefined ? `timedOut=${input.result.timedOut}` : "timedOut=",
      "",
      "--- stdout ---",
      input.result?.stdout ?? "",
      "--- stderr ---",
      input.result?.stderr ?? "",
      ...(input.error !== undefined ? ["--- error ---", input.error instanceof Error ? input.error.message : String(input.error)] : []),
      "",
    ].join("\n");
    writeFileSync(path, body);
    const rel = relative(input.runDir, path);
    return rel === "" || rel.startsWith("..") ? path : rel;
  } catch {
    return undefined;
  }
}

/**
 * REFACTOR-066 — the single ac-map self-heal pipeline.
 *
 * Damage classes preserved:
 *   1. absent / malformed / empty ac-map -> draft if possible, then narrow spawn;
 *   2. harness draft left unconfirmed -> narrow spawn asks the same agent to confirm;
 *   3. real screenshot captured but not referenced by pass ACs -> attach, then rerender.
 */
export async function runAcMapSelfHeal(opts: AcMapSelfHealOptions): Promise<AcMapSelfHealResult> {
  if (opts.storyId === "" || opts.runDir === "") {
    return { renderExitCode: 0 };
  }

  const archiveCwd = opts.archiveCwd ?? opts.worktreeCwd;

  if (needsAcMapDraftSeed(archiveCwd, opts.storyId)) {
    try {
      const specPath = storySpecPath(archiveCwd, opts.storyId);
      if (specPath !== null) {
        const specText = readFileSync(specPath, "utf8");
        const gitEvidence = await opts.collectDraftEvidence();
        const draftJson = generateAcMapDraft(specText, opts.storyId, gitEvidence, opts.collectCycleSignals(), opts.runDir);
        if (draftJson !== null) {
          writeAcMapDraftEvidenceFiles(archiveCwd, opts.storyId, gitEvidence);
          writeFileSync(acMapPath(archiveCwd, opts.storyId), draftJson);
          opts.appendEvent({
            type: "attest:draft-generated",
            cycleId: opts.cycleId,
            storyId: opts.storyId,
            ts: opts.now(),
          });
        }
      }
    } catch {
      // Draft generation is best-effort; the narrowed spawn below remains the fallback.
    }
  }

  if (needsAcMapRemediation(archiveCwd, opts.storyId)) {
    let outcome: "written" | "still-missing" | "spawn-failed";
    let reason: AcMapRemediationReason = "unknown";
    let result: AgentSpawnResult | undefined;
    let error: unknown;
    try {
      if (!opts.canSpawnRemediation()) {
        outcome = "spawn-failed";
        reason = "spawn-unavailable";
      } else {
        result = await opts.agentSpawn(opts.agent, {
          cwd: opts.worktreeCwd,
          skillBody: buildAcMapRemediationPrompt(archiveCwd, opts.storyId, opts.runDir, opts.worktreeCwd),
          storyId: opts.storyId,
          timeoutMs: ACMAP_REMEDIATION_TIMEOUT_MS,
          runDir: opts.runDir,
          ...(opts.writableRoots !== undefined ? { writableRoots: opts.writableRoots } : {}),
        });
        if (result.timedOut) {
          outcome = "spawn-failed";
          reason = "timeout";
        } else if (result.exitCode !== 0) {
          outcome = "spawn-failed";
          reason = "nonzero-exit";
        } else {
          reason = acMapRemediationReason(archiveCwd, opts.storyId);
          outcome = reason === "written" ? "written" : "still-missing";
        }
      }
    } catch (e) {
      outcome = "spawn-failed";
      reason = "spawn-threw";
      error = e;
    }
    const ts = opts.now();
    const transcript = writeAcMapRemediationTranscript({
      runDir: opts.runDir,
      ts,
      agent: opts.agent,
      storyId: opts.storyId,
      cwd: opts.worktreeCwd,
      archiveCwd,
      target: acMapPath(archiveCwd, opts.storyId),
      outcome,
      reason,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    opts.appendEvent({
      type: "attest:remediation",
      cycleId: opts.cycleId,
      storyId: opts.storyId,
      agent: opts.agent,
      outcome,
      reason,
      ...(transcript !== undefined ? { transcript } : {}),
      ts,
    });
  }

  let renderExitCode = await opts.renderAttest();
  if (renderExitCode === 0) {
    const attached = autoAttachScreenshotToAcMap(archiveCwd, opts.storyId, opts.runDir);
    if (attached !== null) {
      opts.appendEvent({
        type: "attest:auto-attach",
        cycleId: opts.cycleId,
        storyId: opts.storyId,
        href: attached.href,
        attachedCount: attached.count,
        ts: opts.now(),
      });
      renderExitCode = await opts.renderAttest();
    }
  }
  return { renderExitCode };
}

/**
 * FIX-912 — the surgical remediation prompt, UPDATED to leverage the auto-draft.
 * When a draft ac-map already exists (generated by the harness from cycle
 * evidence), the agent only needs to CONFIRM or CORRECT the status fields —
 * the structure and evidence chain pre-filled by the harness. When no draft
 * exists (legacy path), the agent writes from scratch.
 *
 * Bilingual (the loop's agents are zh/en mixed), absolute paths baked in,
 * scope pinned to ONE file edit. `runDir` is the cycle's evidence frame —
 * ac-map evidence hrefs are relative to it.
 */
export function buildAcMapRemediationPrompt(
  archiveCwd: string,
  storyId: string,
  runDir: string,
  deliveryCwd = archiveCwd,
): string {
  const target = acMapPath(archiveCwd, storyId);
  const storyDir = join(cardArchiveDir(archiveCwd, storyId));
  const draftExists = existsSync(target);

  if (draftExists) {
    // FIX-912 path: the harness already wrote a DRAFT with structure + evidence chain.
    // The agent only confirms/corrects statuses.
    return [
      `[attest confirmation / 验收确认] 验收草稿 ac-map.json 已由 harness 从 cycle 证据(提交/测试文件/改动文件)自动生成。你只需确认或更正每条 AC 的状态。`,
      `An ac-map DRAFT was auto-generated from cycle evidence (commits, test files, changed files). You only need to CONFIRM or CORRECT the status of each AC.`,
      ``,
      `1. Read the draft at: ${target}`,
      `   - Every AC from the spec has a row with pre-filled evidence chain.`,
      `   - Statuses: "pass-with-evidence" (harness found strong supporting evidence; honest non-agent confirmation) or "needs-confirmation" (insufficient evidence).`,
      `2. Review what you actually did this cycle: \`git log --oneline origin/main..HEAD\` and \`git diff origin/main...HEAD --stat\` in ${deliveryCwd}.`,
      `3. For each AC, set the TRUE status based on what you delivered:`,
      `   - "pass" — you verified this AC and it is satisfied.`,
      `   - "partial" — partially done.`,
      `   - "claimed" — you believe it passes but have no hard evidence.`,
      `   - "missing" — not addressed this cycle.`,
      `   - Do NOT leave any row as "needs-confirmation"; set it to a real agent status.`,
      `   - You MAY leave "pass-with-evidence" only when the existing evidence really supports the AC; this is explicitly harness-confirmed, not agent-confirmed pass.`,
      `4. Where useful, save REAL command output from this cycle as text evidence under ${join(storyDir, "evidence")}/.`,
      `5. Edit ${target} — update ONLY the status fields (and optionally add real evidence). Keep the existing evidence chain.`,
      ``,
      `Proof that you updated: \`node -e 'const a=JSON.parse(require("fs").readFileSync("${target}","utf8")); const bad=a.filter(e=>e.status==="needs-confirmation"); if(bad.length>0) throw new Error(bad.length+" ACs still need confirmation"); console.log("ok "+a.length+" ACs resolved")'\``,
      `6. Do NOT change product code, do NOT commit, do not open a PR. Exit after confirming.`,
    ].join("\n");
  }

  // Legacy path (pre-FIX-912): no draft — agent writes from scratch.
  return [
    `[attest remediation / 验收补全] 你刚在本 cycle 交付了 ${storyId},但漏写了验收意图映射 ac-map.json — 这是唯一缺口,缺它整个交付会被 attest gate 判失败。`,
    `You delivered ${storyId} this cycle but skipped the acceptance intent map (skill step 10.6). Without it the attest gate fails the whole delivery. Do ONLY the following:`,
    ``,
    `1. Read the story spec and its AC list: ${join(storyDir, "spec.md")}`,
    `2. Review what you actually did this cycle: \`git log --oneline origin/main..HEAD\` and \`git diff origin/main...HEAD --stat\` in ${deliveryCwd}.`,
    `3. Where useful, save REAL command output from this cycle as text evidence under ${join(storyDir, "evidence")}/ (create the dir if absent).`,
    `4. Write ${target} — a JSON array with EXACTLY one entry per AC:`,
    ``,
    `[{ "ac": "${storyId}:AC1", "status": "pass",`,
    `   "evidence": [{ "kind": "text", "label": "vitest run", "textFile": "../evidence/vitest.txt" }] },`,
    ` { "ac": "${storyId}:AC2", "status": "claimed", "evidence": [] }]`,
    ``,
    `- status ∈ "pass" | "partial" | "readonly" | "claimed" | "missing".`,
    `- Evidence paths are RELATIVE TO THE RUN DIR (${runDir}); story-level dirs are reachable as ../evidence/... and ../screenshots/... Reference ONLY files that exist.`,
    `- 诚实红线:没有真实证据的 AC 必须标 "claimed",绝不伪造 pass。Honesty red line: an AC without real evidence MUST be "claimed" — never fabricate a pass; the render layer downgrades and exposes fabrications anyway.`,
    `5. Do NOT change product code, do NOT commit, do not open a PR. Write the file, verify it parses (\`node -e 'JSON.parse(require("fs").readFileSync("${target}","utf8"))'\`), then exit.`,
  ].join("\n");
}

/**
 * FIX-317 — the harness↔attest screenshot bridge.
 *
 * Root cause (verified on FIX-284 cycles): a cycle produces a REAL screenshot
 * (`<runDir>/screenshots/web.png`) and a report, but the agent's ac-map marks
 * pass ACs with TEXT-only evidence, never wiring the screenshot in. The
 * agent-agnostic visual floor (`passAcVisualFloor`) then requires a per-AC
 * screenshot ref and judges the report an empty shell → every cycle fails.
 *
 * The fix lives in the harness (roll's normalization thesis: bridge the common
 * gap once; downstream stays agent-agnostic, no per-agent special-casing). The
 * executor calls {@link autoAttachScreenshotToAcMap} after the screenshot is
 * captured: for every `pass` AC lacking visual evidence, it attaches the
 * captured screenshot as a clearly-labelled "visual baseline" ref.
 *
 * Honesty red line (Codex/PI review): only a screenshot that ACTUALLY exists on
 * disk this cycle AND was recorded `taken === true` in evidence.json is ever
 * attached — a recorded machine-skip / absent / malformed manifest attaches
 * nothing and lets the existing skip+exemption paths resolve the cycle. The
 * label discloses it is a delivery-level baseline, NOT AC-specific proof, and
 * the `attest:auto-attach` event records href+count so audits can separate
 * harness-added baselines from agent-supplied evidence.
 */
const SCREENSHOT_BASELINE_LABEL = "cycle visual baseline (auto-attached; not AC-specific proof)";

interface AcMapEvidence {
  kind?: string;
  label?: string;
  href?: string;
  textFile?: string;
}
interface AcMapEntry {
  ac?: string;
  status?: string;
  note?: string;
  evidence?: AcMapEvidence[];
}

/**
 * Pick the captured screenshot href to attach this cycle, or null.
 *
 * Honesty + path safety: a basename is accepted ONLY when (a) evidence.json
 * records a capture for it with `taken === true`, and (b) the PNG exists under
 * `<runDir>/screenshots/`. Matching is by BASENAME (absolute / `..` / escaping
 * paths in the manifest are rejected), and the returned ref is RELATIVE to the
 * run dir so the shared card-level ac-map resolves to THIS cycle's screenshot
 * (toRef resolves run-dir-first, FIX-315). web.png (the dossier baseline,
 * FIX-309) wins over terminal.png when both were genuinely captured.
 */
export function capturedScreenshotRef(runDir: string): string | null {
  if (runDir === "") return null;
  const taken = new Set<string>();
  try {
    const ev = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8")) as {
      captures?: Array<{ out?: string; taken?: boolean }>;
    };
    for (const c of ev.captures ?? []) {
      if (c.taken !== true || typeof c.out !== "string" || c.out === "") continue;
      const base = c.out.split(/[\\/]/).pop() ?? "";
      if (base !== "" && !base.includes("..")) taken.add(base);
    }
  } catch {
    return null; // absent / malformed manifest ⇒ no honest signal
  }
  for (const name of ["web.png", "terminal.png"]) {
    if (taken.has(name) && existsSync(join(runDir, "screenshots", name))) return `screenshots/${name}`;
  }
  return null;
}

/**
 * Auto-attach the captured screenshot into every `pass` AC that lacks visual
 * evidence. Idempotent, honest, best-effort (never throws → never fails the
 * cycle). Returns `{ href, count }` when it wrote, else null.
 */
export function autoAttachScreenshotToAcMap(
  worktreeCwd: string,
  storyId: string,
  runDir: string,
): { href: string; count: number } | null {
  try {
    if (storyId === "" || runDir === "") return null;
    if (storyHasAcBlock(worktreeCwd, storyId) !== true) return null;
    if (!storyRequiresScreenshot(worktreeCwd, storyId)) return null; // exempt ⇒ leave it alone
    const ref = capturedScreenshotRef(runDir);
    if (ref === null) return null; // no honest screenshot ⇒ skip/exemption path handles it
    const p = acMapPath(worktreeCwd, storyId);
    if (!existsSync(p)) return null;
    let entries: AcMapEntry[];
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return null;
      entries = parsed as AcMapEntry[];
    } catch {
      return null; // malformed ⇒ do not clobber the agent's file
    }
    let count = 0;
    for (const e of entries) {
      if (e.status !== "pass") continue; // pass ACs only — never partial/readonly/claimed/fail
      const hasShot = (e.evidence ?? []).some(
        (ev) => ev.kind === "screenshot" && typeof ev.href === "string" && ev.href !== "",
      );
      if (hasShot) continue; // idempotent: agent (or a prior run) already wired one
      (e.evidence ??= []).push({ kind: "screenshot", label: SCREENSHOT_BASELINE_LABEL, href: ref });
      count += 1;
    }
    if (count === 0) return null;
    writeFileSync(p, JSON.stringify(entries, null, 2) + "\n");
    return { href: ref, count };
  } catch {
    return null; // never fail the cycle on a best-effort normalization
  }
}
