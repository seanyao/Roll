/**
 * US-ATTEST-006 — `roll attest <story-id>`: compose the five-piece evidence
 * chain into one acceptance report.
 *
 *   AC parser (core)      → structured AC items from .roll/features/**
 *   evidence collector    → evidence.json hard facts (infra, injectable seams)
 *   ANSI→HTML + renderer  → single-file report.html (core, pure)
 *   screenshots           → CONSUMED if present in the run dir; optional
 *                           --capture-* flags drive the terminal self-capture
 *                           lane and record machine capture facts.
 *
 * Intent hook (the AI layer's contract, consumed when present):
 *   `.roll/verification/<id>/ac-map.json` —
 *     [{ "ac": "<acId>", "status": "pass|pass-with-evidence|readonly|partial|fail|blocked|claimed|missing",
 *        "evidence": [{kind,label,href?,textFile?}], "note": "…" }]
 *   Written by the attest skill during the Gate session (US-ATTEST-007 wiring).
 *   ABSENT map ⇒ every AC renders honestly as 🟧 Claimed (the render-layer red
 *   line) — a standalone run never invents per-AC evidence.
 *
 * Run lifecycle (D4): `.roll/verification/<id>/<run-id>/` (run-id =
 * YYYY-MM-DDTHH-MM-SS, never overwritten) + `latest` symlink. Failure policy
 * (D1): story-not-found errs exit 1; anything else degrades with a WARN and
 * still writes the best report it can, exit 0 — attest must never block
 * delivery.
 */
import {
  acForStory,
  BrowserOperationLedger,
  parseBacklog,
  splitBacklogRow,
  CaptureBridge,
  CapturePlanner,
  captureReceiptEvidenceRef,
  classifyCaptureReceiptV2,
  resolveEvidenceHealth,
  evidenceHealthFact,
  evidenceGateDecision,
  evidenceSignalLabel,
  renderReport,
  ansiPre,
  buildExecutionCastProjection,
  boundTranscript,
  classifyOutwardStatusForReport,
  outwardAcStatusFromVerification,
  buildOutwardEvidenceMap,
  resolveOutwardVerificationStatus,
  EventBus,
  extractCycleSignals,
  smokeCheckReport,
  type AcReportItem,
  type AcStatus,
  type BeforeAfterPair,
  type CaptureLanePort,
  type CaptureRunResult,
  type CaptureSurfaceReport,
  type CaptureSurfaceImage,
  type CardContext,
  type DeclaredSurface,
  type DeliveryCiFact,
  type DeliveryCiRecord,
  type DocGapWarning,
  type EvidenceHealthFact,
  type EvidenceRef,
  type PhysicalCaptureReportEntry,
  type ProcessArchive,
  type RunRow,
  type ReviewScoreReportEntry,
  type OutwardAcReport,
} from "@roll/core";
import {
  ROLL_CAPTURE_PROTOCOL_V1,
  classifyStatus,
  type CaptureIntentV2,
  type CaptureKind,
  type CaptureLedgerEntry,
  type CaptureReceiptV2,
  type CaptureTarget,
  type Lang,
  type OutwardSmokeDeclaration,
  type RollCaptureRequestV1,
  type RollEvent,
  type CycleRoleSummary,
} from "@roll/spec";
import {
  captureReceiptFact,
  captureScreenshot,
  checkCapturePrivacy,
  collectEvidence,
  containsSecret,
  defaultRollCaptureRoot,
  openEvidenceFrame,
  redactSecrets,
  RollCaptureProvider,
  RollCaptureReceiptStore,
  screenshotEvidenceRef,
  writeEvidenceJson,
  type CaptureCommandFact,
  type CaptureFact,
  type CaptureReceiptFact,
  type CapturePrivacyOptions,
  type EvidenceRun,
  type RunOut,
  type RollCaptureProviderPort,
  type ScreenshotDeps,
  type ScreenshotResult,
} from "@roll/infra";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { cardArchiveDir, epicFromFeaturePath, findFeatureFile, findFeatureFiles, reportFileName, reviewFileName } from "../lib/archive.js";
import { currentLang } from "./agent-list.js";
import { physicalTerminalFromSpecText } from "../lib/physical-terminal.js";
import { collectRollCaptureReadiness, type RollCaptureReadiness } from "../lib/roll-capture-readiness.js";
import { designContractDeliveredEvidence } from "../runner/attest-gate.js";
import { skillDispatchActorForCwd } from "../runner/skill-dispatch-workspace.js";
import { resolveCardDeliveryRecord } from "../lib/delivery-record.js";
import { readReviewScoreTrend, readStoryReviewScores } from "../lib/review-score.js";
import { collectToolEvidenceFromEventsPath, formatToolCostSummary } from "../lib/tool-display.js";
import { recordHostDeltaAttestationClosure } from "../lib/delta-allocation.js";
import { attestAuditCommand } from "./attest-audit.js";
import { runOutwardSmoke, smokeResultsFromReport } from "../attest/outward-smoke-runner.js";
import { parseEvaluationContract } from "../lib/evaluation-contract.js";

// Re-export so existing importers (tests, callers) keep their entry point.
export { findFeatureFile } from "../lib/archive.js";

export interface AttestDeps {
  now?: () => Date;
  run?: EvidenceRun;
  ghProbe?: () => Promise<boolean>;
  /** US-ATTEST-011 — seams for the terminal self-capture lane (run/env/platform). */
  capture?: ScreenshotDeps;
  /** US-PHYSICAL-004 — injectable Roll Capture.app provider/readiness seams. */
  rollCapture?: {
    provider?: RollCaptureProviderPort;
    readiness?: () => RollCaptureReadiness;
    root?: string;
    timeoutMs?: number;
    /**
     * US-PHYSICAL-009 — Capture Gateway v2 receipts to persist and fold into the
     * manifest + report. The v2 planner (US-EVID-030) produces these upstream;
     * until then this is an injectable seam (integration fixtures / future
     * caller). ROLL_NO_SCREENCAP never gates this path.
     */
    receipts?: readonly { intent: CaptureIntentV2; receipt: CaptureReceiptV2 }[];
    /**
     * US-EVID-030 — declared visual surfaces + their injected lane executors.
     * When present, the CapturePlanner PLANS and DISPATCHES every policy-eligible
     * lane per surface, records all attempts into one CaptureSet via the durable
     * store, and folds accepted images into the manifest + report. Additive and
     * default-off (there is no live Capture.app / browser in CI, so lanes are
     * injected). ROLL_NO_SCREENCAP never gates this planner.
     */
    captureSurfaces?: readonly { surface: DeclaredSurface; lanes: readonly CaptureLanePort[] }[];
  };
  /** US-ATTEST-014 — injectable seam for the cycle process archive sources. */
  process?: ProcessReaders;
}

/**
 * US-ATTEST-014 — the process-archive data sources (runs.jsonl rows, the event
 * stream, and the per-cycle transcript log). Injectable so the reverse-lookup +
 * scoping logic is unit-testable without touching the real runtime dir.
 */
export interface ProcessReaders {
  runs(): RunRow[];
  events(): RollEvent[];
  /** Raw transcript text for a cycle, or null when the log is absent. */
  transcript(cycleId: string): string | null;
  /** Project-relative path to the machine original (indexed, not embedded). */
  transcriptPath(cycleId: string): string;
  /** Tool cost summary for a cycle, sourced from cycle:end cost.toolCosts. */
  toolCostSummary?(cycleId: string): string;
}

/** Default readers over `<runtimeDir>/{runs.jsonl,events.ndjson,cycle-logs/}`. */
function defaultProcessReaders(projectPath: string, env: Record<string, string | undefined>): ProcessReaders {
  const rt = (env.ROLL_PROJECT_RUNTIME_DIR ?? "").trim() || join(projectPath, ".roll", "loop");
  // Reuse the event bus's read side — it already parses runs.jsonl / events.ndjson
  // and returns [] for a missing file (readText → "" on absence), no throw.
  const bus = new EventBus();
  const logPath = (cid: string): string => join(rt, "cycle-logs", `${cid}.agent.log`);
  const toolEvidence = () => collectToolEvidenceFromEventsPath(join(rt, "events.ndjson"));
  return {
    runs: () => bus.readRuns(join(rt, "runs.jsonl")),
    events: () => bus.readEvents(join(rt, "events.ndjson")),
    transcript: (cid) => {
      const p = logPath(cid);
      if (!existsSync(p)) return null;
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    transcriptPath: (cid) => relative(projectPath, logPath(cid)),
    toolCostSummary: (cid) => formatToolCostSummary(toolEvidence().costsByCycle.get(cid), " · "),
  };
}

/**
 * US-ATTEST-014 — reverse-lookup the cycle that delivered a story. Scans
 * runs.jsonl rows (latest wins, so a rebuilt story resolves to its newest
 * cycle), matching `story_id` or membership in the `built[]` array. `found`
 * distinguishes a loop delivery (row exists) from a hand-delivered card (none).
 */
export function resolveStoryCycle(runs: RunRow[], storyId: string): { cycleId?: string; agent?: string; found: boolean } {
  let hit: RunRow | null = null;
  for (const row of runs) {
    const sid = row["story_id"];
    const built = row["built"];
    const match = sid === storyId || (Array.isArray(built) && built.includes(storyId));
    if (match) hit = row; // keep scanning — latest match wins
  }
  if (hit === null) return { found: false };
  const cycleId = typeof hit["cycle_id"] === "string" ? (hit["cycle_id"] as string) : undefined;
  const agent = typeof hit["agent"] === "string" && hit["agent"] !== "" ? (hit["agent"] as string) : undefined;
  return {
    found: true,
    ...(cycleId !== undefined && cycleId !== "" ? { cycleId } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/**
 * US-ATTEST-014 — scope the global event stream to ONE cycle+story for the
 * trace extractor. cycleId-bearing events (lifecycle/tcr/gates) must match the
 * cycle; PR events carry the storyId and are kept when it matches; CI events
 * carry only a prNumber, so they ride along when their PR belongs to the story.
 * alert:notify has no story link and is dropped (un-attributable, never guessed).
 */
export function scopeCycleEvents(events: RollEvent[], cycleId: string | undefined, storyId: string): RollEvent[] {
  const prSet = new Set<number>();
  for (const ev of events) {
    if ((ev.type === "pr:open" || ev.type === "pr:merge") && ev.storyId === storyId) prSet.add(ev.prNumber);
  }
  return events.filter((ev) => {
    if ("cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string") {
      return cycleId !== undefined && (ev as { cycleId: string }).cycleId === cycleId;
    }
    if (ev.type === "pr:open" || ev.type === "pr:merge") return ev.storyId === storyId;
    if (ev.type === "pr:rebase" || ev.type === "pr:close") return prSet.has(ev.prNumber);
    if (ev.type === "ci:pass" || ev.type === "ci:fail" || ev.type === "ci:rerun") return prSet.has(ev.prNumber);
    return false; // alert:notify, loop:*, policy:*, route:* — not story-scoped here
  });
}

/**
 * US-ATTEST-014 — assemble the cycle process archive (timeline + signal layer +
 * bounded transcript). Tri-state, all degrading gracefully (D1, never throws):
 *   1. run row found            → `loop` delivery, full archive.
 *   2. no row but story events  → `manual` delivery (conductor 手工交付).
 *   3. nothing at all           → undefined (the renderer trims the section).
 * Sensitive strings in the transcript pass through 012's redaction pipeline
 * BEFORE inlining (a hit is WARNed, never silent).
 */
export function buildProcessArchive(storyId: string, readers: ProcessReaders): ProcessArchive | undefined {
  const { cycleId, agent, found } = resolveStoryCycle(readers.runs(), storyId);
  const scoped = scopeCycleEvents(readers.events(), cycleId, storyId);
  const { timeline } = extractCycleSignals(scoped, cycleId ?? "");

  // case 3: nothing to show
  if (!found && timeline.length === 0) return undefined;

  const delivery: ProcessArchive["delivery"] = found && cycleId !== undefined ? "loop" : "manual";
  const missing: string[] = [];
  const archive: ProcessArchive = { delivery };
  if (cycleId !== undefined) archive.cycleId = cycleId;
  if (agent !== undefined) archive.agent = agent;
  if (timeline.length > 0) archive.timeline = timeline;
  else missing.push("timeline");
  if (cycleId !== undefined && readers.toolCostSummary !== undefined) {
    const tools = readers.toolCostSummary(cycleId);
    if (tools !== "") archive.toolCostSummary = tools;
  }
  if (delivery === "manual") missing.push("cycle");

  // transcript — only loop cycles have an agent log; redact → bound → ANSI.
  if (cycleId !== undefined) {
    const raw = readers.transcript(cycleId);
    if (raw !== null) {
      const { redacted, hits } = redactSecrets(raw);
      if (hits.length > 0) warn(`redacted secret(s) in cycle transcript ${cycleId}: ${hits.join(", ")}`);
      const bounded = boundTranscript(redacted);
      archive.transcript = {
        inlineHtml: ansiPre(bounded.text),
        truncated: bounded.truncated,
        totalLen: bounded.totalLen,
        shownLen: bounded.shownLen,
        originalPath: readers.transcriptPath(cycleId),
      };
    } else {
      missing.push("transcript");
    }
  } else {
    missing.push("transcript");
  }

  if (missing.length > 0) archive.missing = missing;
  return archive;
}


/**
 * US-OBS-034 — read the cached CycleRoleSummary (summary.json) from a cycle's
 * log directory. Returns undefined when the file is absent or unparseable, so
 * the attest report gracefully degrades.
 */
export function readCycleRoleSummary(projectPath: string, cycleId: string): CycleRoleSummary | undefined {
  const rt = join(projectPath, '.roll', 'loop');
  const summaryPath = join(rt, 'cycle-logs', cycleId, 'summary.json');
  try {
    if (!existsSync(summaryPath)) return undefined;
    const raw = readFileSync(summaryPath, 'utf8');
    return JSON.parse(raw) as CycleRoleSummary;
  } catch {
    return undefined;
  }
}


const STATUSES: readonly AcStatus[] = ["pass", "pass-with-evidence", "readonly", "partial", "fail", "blocked", "claimed", "missing"];
const execFileAsync = promisify(execFile);

function warn(msg: string): void {
  process.stderr.write(`[roll] attest WARN: ${msg}\n`);
}

/**
 * US-EVID-031 — turn a retained (taken) v2 receipt into one CaptureSurfaceImage
 * with its provenance, physical/rendered class, hash, and a linked receipt. The
 * PNG + receipt paths are rewritten run-relative so the report is offline-openable.
 */
function surfaceImageFromReceipt(receipt: CaptureReceiptV2, runDir: string): CaptureSurfaceImage {
  const ref = captureReceiptEvidenceRef(receipt);
  const label = ref?.label ?? `${receipt.captureClass === "physical" ? "Roll Capture · physical" : "Playwright · rendered"} · ${receipt.surfaceId}`;
  const receiptHref =
    receipt.responsePath !== undefined && receipt.responsePath !== ""
      ? isAbsolute(receipt.responsePath)
        ? relative(runDir, receipt.responsePath)
        : receipt.responsePath
      : undefined;
  return {
    source: receipt.source,
    captureClass: receipt.captureClass,
    label,
    ...(ref?.href !== undefined ? { href: ref.href } : {}),
    ...(receipt.sha256 !== undefined ? { sha256: receipt.sha256 } : {}),
    ...(receiptHref !== undefined ? { receiptHref } : {}),
    requestId: receipt.requestId,
  };
}

function handoffLines(lang: Lang, reviewPath: string, legacyReportPath: string): string[] {
  if (lang === "zh") {
    return [
      "验收 Review Page：",
      `  ${reviewPath}`,
      "旧报告兼容别名：",
      `  ${legacyReportPath}`,
      "",
    ];
  }
  return [
    "Acceptance Review Page:",
    `  ${reviewPath}`,
    "legacy report alias:",
    `  ${legacyReportPath}`,
    "",
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandInProject(projectPath: string, command: string): string {
  return `cd ${shellQuote(projectPath)} && ${command}`;
}

function tail(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

// FIX-1484: a capture command may be a FULL test suite (`roll test --full`
// runs thousands of tests over many minutes). The old 120s / 4MB limits killed
// such commands mid-run — and the kill was then misreported as "exit 1".
const CAPTURE_COMMAND_TIMEOUT_MS = 30 * 60_000;
const CAPTURE_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

/** FIX-1484: RunOut plus an explicit harness-kill cause (timeout / maxBuffer). */
export type CaptureShellOut = RunOut & { killedBy?: string };

export async function runShell(
  line: string,
  deps: ScreenshotDeps | undefined,
  opts?: { timeoutMs?: number },
): Promise<CaptureShellOut> {
  // RED LINE (US-ATTEST-012 / FIX-339 复核 #2): the GUI screen-capture lane already
  // refuses a command whose body carries a secret (screenshot.ts) — a token baked
  // into pixels can't be un-baked. The non-GUI command sink runs the command and
  // persists its output, so it needs the SAME guard: a command body
  // carrying a secret must NOT run (it could echo/leak the token into the captured
  // stdout). Refuse it before any spawn; the caller records an honest skip.
  if (containsSecret(line)) {
    return { code: 1, stdout: "", stderr: "«REDACTED» secret in capture command — refused (redact & retry)" };
  }
  const injected = deps?.run;
  if (injected !== undefined) return injected("sh", ["-lc", line]);
  const timeoutMs = opts?.timeoutMs ?? CAPTURE_COMMAND_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", line], {
      encoding: "utf8",
      maxBuffer: CAPTURE_COMMAND_MAX_BUFFER,
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    // FIX-1484: a REAL exit code arrives as a number and passes through
    // untouched. A harness kill is NOT the command's exit code — timeout gives
    // code:null + signal SIGTERM, maxBuffer gives string code
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Both used to be flattened to "exit 1",
    // which condemned green suites and hid the cause. Report the kill as a kill.
    const err = e as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      signal?: string;
      message?: string;
    };
    if (typeof err.code === "number") {
      return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    if (err.signal !== undefined) {
      const sigNo = osConstants.signals[err.signal as keyof typeof osConstants.signals] ?? 0;
      return {
        code: 128 + sigNo,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        killedBy: `killed by the capture harness: signal ${err.signal} (timeout ${timeoutMs}ms or external kill) — NOT the command's exit code`,
      };
    }
    return {
      code: 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      killedBy: `killed by the capture harness: ${String(err.code ?? err.message ?? "spawn error")} — NOT the command's exit code`,
    };
  }
}

interface CaptureDumpTarget {
  /** This attest run's dir; the failure dump lands under its `evidence/`. */
  runDir: string;
  /** File stem per capture lane (capture-command, capture-command-1, …). */
  stem: string;
}

async function captureCommandFact(
  projectPath: string,
  command: string,
  deps: ScreenshotDeps | undefined,
  dump?: CaptureDumpTarget,
): Promise<CaptureCommandFact> {
  const wrappedCommand = commandInProject(projectPath, command);
  // FIX-339 (复核 #2): a secret in the command body ⇒ refuse, never run (runShell
  // guards). Surface a non-zero exit so the caller records a taken:false skip.
  if (containsSecret(wrappedCommand)) {
    return {
      command,
      wrappedCommand,
      exitCode: 1,
      stdoutTail: "",
      stderrTail: "«REDACTED» secret in capture command — refused (redact & retry)",
    };
  }
  const r = await runShell(wrappedCommand, deps);
  // FIX-339 (复核 #2): scrub the PERSISTED stdout/stderr with the same redaction
  // pipeline used for inlined evidence — a token printed BY the command
  // (env dump, debug log) must never land in the archived evidence fact. A hit is
  // WARNed (留痕), never silent. FIX-1484: redact the FULL stream first, then cap
  // the report tail — the cap governs display only, never what gets preserved.
  const outR = redactSecrets(r.stdout);
  const errR = redactSecrets(r.stderr);
  if (outR.hits.length > 0 || errR.hits.length > 0) {
    warn(`redacted secret(s) in capture command output (${command}): ${[...outR.hits, ...errR.hits].join(", ")}`);
  }
  // FIX-1484: a capped tail alone cannot explain WHY a capture failed — on
  // failure persist the full redacted streams under the run's evidence/ so the
  // report is self-diagnosable (paths recorded relative to the run dir).
  let outputDump: { stdout?: string; stderr?: string } | undefined;
  if (r.code !== 0 && dump !== undefined) {
    const dir = join(dump.runDir, "evidence");
    const dumpFiles: { stdout?: string; stderr?: string } = {};
    if (outR.redacted !== "") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${dump.stem}.stdout.log`), outR.redacted, "utf8");
      dumpFiles.stdout = `evidence/${dump.stem}.stdout.log`;
    }
    if (errR.redacted !== "") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${dump.stem}.stderr.log`), errR.redacted, "utf8");
      dumpFiles.stderr = `evidence/${dump.stem}.stderr.log`;
    }
    if (dumpFiles.stdout !== undefined || dumpFiles.stderr !== undefined) outputDump = dumpFiles;
  }
  return {
    command,
    wrappedCommand,
    exitCode: r.code,
    stdoutTail: tail(outR.redacted),
    stderrTail: (r.killedBy !== undefined ? `[${r.killedBy}]\n` : "") + tail(errR.redacted),
    ...(outputDump !== undefined ? { outputDump } : {}),
  };
}

export function captureFactFromShot(shot: ScreenshotResult, forcedError?: string): CaptureFact {
  const failed = !shot.taken && shot.failed === true;
  const error = failed ? forcedError ?? shot.error ?? shot.skipped ?? "capture failed" : undefined;
  return {
    kind: shot.kind,
    out: shot.out,
    taken: shot.taken,
    ...(shot.skipped !== undefined ? { skipped: shot.skipped } : {}),
    ...(failed ? { failed: true, error } : {}),
  };
}

import { assessDocGapFromFiles, normalizeDiffPath } from "../lib/doc-drift.js";
// US-RULE-004a — the doc-gap rules live in ONE shared home (lib/doc-drift.ts);
// attest re-exports them so its public surface and behavior contract are
// unchanged. Never fork a second copy of these rules into a caller.
export {
  assessDocGapFromFiles,
  isDocAlignmentFile,
  isUserVisibleSurfaceFile,
} from "../lib/doc-drift.js";

function gitNameOnly(projectPath: string, args: readonly string[]): string[] {
  try {
    const out = execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map(normalizeDiffPath)
      .filter((file) => file !== "");
  } catch {
    return [];
  }
}

function collectChangedFiles(projectPath: string): string[] {
  const candidates: readonly (readonly string[])[] = [
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "origin/main...HEAD"],
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "main...HEAD"],
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD~1..HEAD"],
    ["diff", "--name-only", "--diff-filter=ACMRTUXB"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
  ];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const args of candidates) {
    for (const file of gitNameOnly(projectPath, args)) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function detectDocGap(projectPath: string): DocGapWarning | undefined {
  return assessDocGapFromFiles(collectChangedFiles(projectPath));
}

interface AcMapEntry {
  ac: string;
  status?: string;
  note?: string;
  evidence?: Array<{ kind?: string; label?: string; href?: string; textFile?: string }>;
}

const DEFAULT_MAX_CAST_BYTES = 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 25 * 1024 * 1024;

function maxBytes(kind: "cast" | "video"): number {
  const envKey = kind === "cast" ? "ROLL_EVIDENCE_MAX_CAST_BYTES" : "ROLL_EVIDENCE_MAX_VIDEO_BYTES";
  const raw = Number(process.env[envKey]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return kind === "cast" ? DEFAULT_MAX_CAST_BYTES : DEFAULT_MAX_VIDEO_BYTES;
}

/** FIX-332: a cycle that RESUMES an un-merged branch lands in a fresh run dir.
 *  If the agent replays the old commit and deposits no new evidence, the current
 *  run dir is empty — but the card archive still holds the prior cycle's evidence
 *  in sibling run dirs. We bridge ONLY when the current run dir has no evidence of
 *  its own, and we prefer newer siblings first. This keeps the honesty red line
 *  for normal cycles (a populated run dir never silently inherits stale files)
 *  while preventing the resume-empty-shell death spiral.
 *
 *  A run dir is considered "evidenced" when it carries any real artifact file
 *  (text logs under `evidence/`, screenshots under `screenshots/`, cast/video at
 *  the run root, …). The `evidence.json` manifest alone does NOT count — it is
 *  written for every cycle, even when no capture succeeded. */
function runDirHasEvidence(runDir: string): boolean {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(runDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name === "evidence.json") continue;
    if (e.isDirectory()) {
      try {
        if (readdirSync(join(runDir, e.name)).some((f) => f !== "")) return true;
      } catch {
        /* unreadable subdir: ignore */
      }
    } else {
      return true;
    }
  }
  return false;
}

const RUN_DIR_NAME_RE = /^(\d{4}-\d{2}-\d{2}T|cycle-)/;

/** Sorted candidate sibling run dirs under the card archive, newest first.
 *  Excludes the current run dir and non-run subdirs (notes, latest, etc). */
function siblingRunDirs(cardDir: string, currentRunDir: string): string[] {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(cardDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const currentBase = basename(currentRunDir);
  const dirs = entries
    .filter((e) => e.isDirectory() && RUN_DIR_NAME_RE.test(e.name) && e.name !== currentBase)
    .map((e) => join(cardDir, e.name));
  try {
    dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    /* mtime unreadable: keep directory order */
  }
  return dirs;
}

/** FIX-315 + FIX-332: resolve a relative evidence ref against the run/era dir,
 *  the card/story archive dir, and (only for an empty current run dir) prior
 *  sibling run dirs from resumed work. Returns the first existing path, or null
 *  — the file must actually exist; the red line is preserved by construction. */
function resolveEvidenceFile(
  runDir: string,
  cardDir: string,
  ref: string,
  siblingBases: readonly string[] = [],
): string | null {
  for (const base of [runDir, cardDir, ...siblingBases]) {
    const refs = /^\.\.\/(?:evidence|screenshots)\//.test(ref) ? [ref, ref.slice(3)] : [ref];
    for (const candidateRef of refs) {
      const p = join(base, candidateRef);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function localEvidencePath(
  runDir: string,
  cardDir: string,
  href: string,
  siblingBases: readonly string[] = [],
): string | null {
  if (href === "" || href.startsWith("/") || href.includes("..") || /^[a-z]+:/i.test(href)) return null;
  return resolveEvidenceFile(runDir, cardDir, href, siblingBases);
}

/** Read + validate the optional AI intent map; null when absent/malformed. */
function readAcMap(storyDir: string): Map<string, AcMapEntry> | null {
  const p = join(storyDir, "ac-map.json");
  if (!existsSync(p)) return null;
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as AcMapEntry[];
    if (!Array.isArray(arr)) return null;
    const m = new Map<string, AcMapEntry>();
    for (const e of arr) if (typeof e?.ac === "string") m.set(e.ac, e);
    return m;
  } catch {
    warn("ac-map.json malformed — rendering without intent mapping");
    return null;
  }
}

function toRef(
  runDir: string,
  cardDir: string,
  e: NonNullable<AcMapEntry["evidence"]>[number],
  siblingBases: readonly string[] = [],
): EvidenceRef | null {
  const kind = (e.kind ?? "") as EvidenceRef["kind"];
  const label = e.label ?? kind;
  if (kind === "text" && e.textFile !== undefined) {
    const p = resolveEvidenceFile(runDir, cardDir, e.textFile, siblingBases);
    if (p === null) return null;
    try {
      // RED LINE (US-ATTEST-012): scrub secrets/PII BEFORE the text is inlined
      // into the report — once archived, the run dir is never overwritten. A
      // hit is WARNed, never silent (留痕).
      const { redacted, hits } = redactSecrets(readFileSync(p, "utf8"));
      if (hits.length > 0) warn(`redacted secret(s) in ${e.textFile}: ${hits.join(", ")}`);
      return { kind, label, inlineHtml: ansiPre(redacted) };
    } catch {
      return null;
    }
  }
  if ((kind === "cast" || kind === "video") && e.href !== undefined) {
    const p = localEvidencePath(runDir, cardDir, e.href, siblingBases);
    if (p === null || !existsSync(p)) return null;
    try {
      const size = statSync(p).size;
      if (size > maxBytes(kind)) {
        warn(`${kind} evidence too large (${size} bytes > ${maxBytes(kind)}): ${e.href}`);
        return null;
      }
      if (kind === "cast") {
        const { redacted, hits } = redactSecrets(readFileSync(p, "utf8"));
        if (hits.length > 0) warn(`redacted secret(s) in ${e.href}: ${hits.join(", ")}`);
        const bounded = boundTranscript(redacted);
        return { kind, label, href: e.href, inlineHtml: ansiPre(bounded.text) };
      }
      return { kind, label, href: e.href };
    } catch {
      return null;
    }
  }
  if (["screenshot", "commit", "ci", "deploy", "test-pass"].includes(kind)) {
    return e.href !== undefined ? { kind, label, href: e.href } : { kind, label };
  }
  return null;
}

function relativeFromPhysical(fromDir: string, toPath: string): string {
  try {
    return relative(realpathSync(fromDir), realpathSync(toPath));
  } catch {
    return relative(fromDir, toPath);
  }
}

function frontmatterBlock(specText: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(specText);
  return m === null ? null : (m[1] ?? "");
}

function stripYamlInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === "'" || ch === '"') && (i === 0 || value[i - 1] !== "\\")) {
      quote = quote === ch ? null : quote === null ? ch : quote;
      continue;
    }
    if (ch === "#" && quote === null && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function frontmatterScalar(specText: string, key: string): string | null {
  const fm = frontmatterBlock(specText);
  if (fm === null) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "m");
  const m = re.exec(fm);
  if (m === null) return null;
  const raw = stripYamlInlineComment(m[1] ?? "").trim();
  if (raw === "") return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1).trim();
  return raw;
}

function declaresPhysicalEvidenceProfile(specText: string): boolean {
  return frontmatterScalar(specText, "evidence_profile") === "physical";
}

function hrefInsideRunDir(runDir: string, path: string): string | undefined {
  const rel = relativeFromPhysical(runDir, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/") ? rel : undefined;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function hasImageSignature(path: string): boolean {
  try {
    const bytes = readFileSync(path).subarray(0, 12);
    return (
      (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
      (bytes.length >= 6 && (bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) || bytes.subarray(0, 6).equals(Buffer.from("GIF89a")))) ||
      (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP")))
    );
  } catch {
    return false;
  }
}

function captureEvidenceRef(shot: ScreenshotResult, href: string): EvidenceRef | null {
  if (!shot.taken) return null;
  if (IMAGE_EXTENSIONS.has(extname(shot.out).toLowerCase()) || hasImageSignature(shot.out)) {
    return screenshotEvidenceRef(shot, href);
  }
  try {
    const { redacted, hits } = redactSecrets(readFileSync(shot.out, "utf8"));
    if (hits.length > 0) warn(`redacted secret(s) in capture ${href}: ${hits.join(", ")}`);
    return { kind: "text", label: shot.kind, href, inlineHtml: ansiPre(redacted) };
  } catch {
    warn(`captured artifact could not be read as text: ${href}`);
    return null;
  }
}

interface PhysicalCaptureLane {
  report: PhysicalCaptureReportEntry;
  fact: CaptureFact;
  selfCapture?: EvidenceRef;
  captureResponse?: import("@roll/spec").RollCaptureResponseV1;
  captureDigest?: string;
}

function physicalScreenshotRequest(
  specText: string,
  storyId: string,
  runId: string,
  runDir: string,
  createdAt: string,
  timeoutMs: number,
  skipPhysicalTerminalProvider: boolean,
  captureFullscreen: boolean,
): RollCaptureRequestV1 | null {
  const physicalTerminal = physicalTerminalFromSpecText(specText);
  if (physicalTerminal !== null && skipPhysicalTerminalProvider) return null;
  const explicitPhysical = physicalTerminal !== null || declaresPhysicalEvidenceProfile(specText);
  if (!explicitPhysical) return null;

  const kind: CaptureKind = physicalTerminal !== null ? "physical_terminal" : "display";
  let target: CaptureTarget;
  if (physicalTerminal !== null) {
    target = { type: "window", appName: physicalTerminal.app };
  } else if (captureFullscreen) {
    // US-PHYSICAL-006: full-screen only when explicitly declared
    target = { type: "display" };
  } else {
    // US-PHYSICAL-006: default to window-level, derive app from evidence type
    const appName = derivePhysicalScreenshotApp(specText);
    target = { type: "window", appName };
  }
  const requestId = safeCaptureRequestId(`${storyId}-${runId}-physical`);
  return {
    protocol: ROLL_CAPTURE_PROTOCOL_V1,
    requestId,
    storyId,
    runId,
    kind,
    target,
    out: join(runDir, "screenshots", "physical.png"),
    timeoutMs,
    createdAt,
  };
}

/**
 * Derive the default application name for a physical screenshot window target
 * from the card spec. For web-evidence cards (deliverable_url / screenshot_url)
 * we target the browser; for all others (terminal/cmd cards) we target Terminal.app.
 * US-PHYSICAL-006 — privacy-first default: window-level, never full-screen.
 */
function derivePhysicalScreenshotApp(specText: string): string {
  if (
    frontmatterScalar(specText, "deliverable_url") !== null ||
    frontmatterScalar(specText, "screenshot_url") !== null
  ) {
    return "Google Chrome";
  }
  return "Terminal.app";
}

function safeCaptureRequestId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
}

async function runPhysicalScreenshotLane(
  request: RollCaptureRequestV1,
  readiness: RollCaptureReadiness,
  provider: RollCaptureProviderPort,
  ledgerRoot: string,
  captureFullscreen: boolean,
): Promise<PhysicalCaptureLane> {
  mkdirSync(dirname(request.out), { recursive: true });
  if (readiness.status !== "available") {
    const reason = readiness.detailLines.join("; ") || "Roll Capture.app is not ready";
    return physicalLaneResult(request, ["requested", "skipped", "not-attached"], reason, undefined, readCaptureLedgerEntries(ledgerRoot, request.requestId));
  }

  const requestPath = join(ledgerRoot, "inbox", `request-${request.requestId}.json`);
  try {
    await provider.writeRequest(request);
    const result = await provider.waitForResponse(request, { timeoutMs: request.timeoutMs });
    const ledger = readCaptureLedgerEntries(ledgerRoot, request.requestId);
    const responsePath = result.status === "timeout" ? undefined : result.response.responsePath;
    if (result.status === "taken") {
      // US-PHYSICAL-007 — privacy check before the image enters the evidence chain.
      const privacyOptions: CapturePrivacyOptions = { declaredFullscreen: captureFullscreen };
      const privacy = checkCapturePrivacy(request, result.response, privacyOptions);
      if (!privacy.ok) {
        return physicalLaneResult(
          request,
          ["requested", "taken", "privacy-rejected"],
          privacy.reason,
          undefined,
          ledger,
          requestPath,
          responsePath,
          privacy.annotation,
          result.response,
        );
      }
      const attached = attachPhysicalScreenshot(result.path, request.out);
      if (attached.ok) {
        const captureResponse = { ...result.response, screenshotPath: request.out };
        return physicalLaneResult(
          request,
          ["requested", "taken", "attached"],
          undefined,
          `screenshots/${basename(request.out)}`,
          ledger,
          requestPath,
          responsePath,
          privacy.annotation,
          captureResponse,
          await sha256File(request.out),
        );
      }
      return physicalLaneResult(request, ["requested", "taken", "not-attached"], attached.reason, undefined, ledger, requestPath, responsePath, undefined, result.response);
    }
    if (result.status === "timeout") {
      return physicalLaneResult(request, ["requested", "timeout", "not-attached"], `timeout: ${result.reason}`, undefined, ledger, requestPath);
    }
    return physicalLaneResult(request, ["requested", result.status, "not-attached"], result.reason, undefined, ledger, requestPath, responsePath, undefined, result.response);
  } catch (error) {
    return physicalLaneResult(
      request,
      ["requested", "failed", "not-attached"],
      error instanceof Error ? error.message : String(error),
      undefined,
      readCaptureLedgerEntries(ledgerRoot, request.requestId),
      requestPath,
    );
  } finally {
    rmSync(requestPath, { force: true });
  }
}

function physicalLaneResult(
  request: RollCaptureRequestV1,
  statusChain: readonly string[],
  reason: string | undefined,
  screenshotHref: string | undefined,
  ledger: readonly CaptureLedgerEntry[],
  requestPath?: string,
  responsePath?: string,
  annotation?: import("@roll/core").CaptureAnnotation,
  captureResponse?: import("@roll/spec").RollCaptureResponseV1,
  captureDigest?: string,
): PhysicalCaptureLane {
  const runDir = dirname(dirname(request.out));
  const attached = screenshotHref !== undefined;
  const failed = !attached && physicalCaptureFailed(statusChain);
  const screenshot: EvidenceRef | undefined = attached
    ? { kind: "screenshot", label: "physical.screenshot", href: screenshotHref }
    : undefined;
  return {
    report: {
      provider: "physical.screenshot",
      kind: request.kind,
      statusChain,
      ...(reason !== undefined && reason !== "" ? { reason } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
      ...reportPathField(runDir, "requestPath", requestPath),
      ...reportPathField(runDir, "responsePath", responsePath),
      ...(ledger.length > 0 ? { ledgerLinks: ledgerLinksForReport(runDir, ledger) } : {}),
      ...(ledger.length > 0 ? { ledgerDetails: ledgerDetailsForReport(ledger) } : {}),
      ...(annotation !== undefined ? { annotation } : {}),
    },
    fact: {
      kind: request.kind,
      out: request.out,
      taken: attached,
      ...(!attached && reason !== undefined && reason !== "" ? { skipped: reason } : {}),
      ...(failed && reason !== undefined && reason !== "" ? { failed: true, error: reason } : {}),
    },
    ...(screenshot !== undefined ? { selfCapture: screenshot } : {}),
    ...(captureResponse !== undefined ? { captureResponse } : {}),
    ...(captureDigest !== undefined ? { captureDigest } : {}),
  };
}

function sha256File(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    input.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    input.on("error", () => resolve(undefined));
  });
}

/** Persist the physical attest result as the authoritative browser capture fact. */
function recordAttestCaptureBridgeLink(projectPath: string, request: RollCaptureRequestV1, physical: PhysicalCaptureLane): void {
  if (physical.captureResponse === undefined || request.storyId === undefined || request.storyId === "") return;
  try {
    const bridge = new CaptureBridge();
    const link = bridge.linkCapture(
      `attest:${request.runId ?? request.requestId}`,
      request.storyId,
      request.requestId,
      "passed",
      physical.captureResponse,
      physical.captureDigest,
    );
    if (link === null) return;
    new BrowserOperationLedger().recordCaptureLink(
      join(projectPath, ".roll", "browser-operations", "events.ndjson"),
      link,
    );
  } catch (error) {
    warn(`could not persist browser capture link: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function physicalCaptureFailed(statusChain: readonly string[]): boolean {
  if (statusChain.includes("failed") || statusChain.includes("timeout") || statusChain.includes("privacy-rejected")) return true;
  return statusChain.includes("taken") && statusChain.includes("not-attached");
}

function reportPathField(
  runDir: string,
  key: "requestPath" | "responsePath",
  path: string | undefined,
): Pick<PhysicalCaptureReportEntry, "requestPath" | "responsePath"> {
  if (path === undefined) return {};
  const href = hrefInsideRunDir(runDir, path);
  return href === undefined ? {} : { [key]: href };
}

function attachPhysicalScreenshot(source: string, out: string): { ok: true } | { ok: false; reason: string } {
  try {
    if (source !== out) copyFileSync(source, out);
    if (!existsSync(out)) return { ok: false, reason: "physical.screenshot did not produce an attached PNG" };
    if (!hasPngSignature(out)) {
      rmSync(out, { force: true });
      return { ok: false, reason: "physical.screenshot did not produce a valid PNG" };
    }
    return { ok: true };
  } catch (error) {
    rmSync(out, { force: true });
    return { ok: false, reason: `attach failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function hasPngSignature(path: string): boolean {
  try {
    return readFileSync(path).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    return false;
  }
}

function readCaptureLedgerEntries(root: string, requestId: string): CaptureLedgerEntry[] {
  const out: CaptureLedgerEntry[] = [];
  for (const path of [join(root, "ledger.jsonl"), join(root, "ledger.ndjson"), join(root, "capture-ledger.jsonl"), join(root, "ledger.json")]) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw === "") continue;
      const values = path.endsWith(".json")
        ? (JSON.parse(raw) as unknown)
        : raw.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
      const rows = Array.isArray(values) ? values : [values];
      for (const row of rows) {
        if (isCaptureLedgerEntry(row) && row.requestId === requestId) out.push(row);
      }
    } catch {
      /* malformed ledger: ignore, provider response remains authoritative */
    }
  }
  return out;
}

function isCaptureLedgerEntry(value: unknown): value is CaptureLedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["requestId"] === "string" &&
    typeof row["status"] === "string" &&
    typeof row["responsePath"] === "string" &&
    typeof row["attachedToReport"] === "boolean" &&
    typeof row["startedAt"] === "string" &&
    typeof row["finishedAt"] === "string"
  );
}

function ledgerLinksForReport(runDir: string, entries: readonly CaptureLedgerEntry[]): Array<{ label: string; href: string }> {
  return entries.flatMap((entry, index) => {
    const n = entries.length === 1 ? "" : ` ${index + 1}`;
    return [
      ...ledgerLink(runDir, `ledger response${n}`, entry.responsePath),
      ...(entry.reportPath !== undefined && entry.reportPath !== "" ? ledgerLink(runDir, `ledger report${n}`, entry.reportPath) : []),
    ];
  });
}

function ledgerLink(runDir: string, label: string, path: string): Array<{ label: string; href: string }> {
  const href = hrefInsideRunDir(runDir, path);
  return href === undefined ? [] : [{ label, href }];
}

function ledgerDetailsForReport(entries: readonly CaptureLedgerEntry[]): string[] {
  return entries.flatMap((entry, index) => {
    const n = entries.length === 1 ? "" : ` ${index + 1}`;
    const details = [`ledger response${n}: ${entry.responsePath}`, `attachedToReport=${String(entry.attachedToReport)}`];
    if (entry.screenshotPath !== undefined && entry.screenshotPath !== "") details.push(`ledger screenshot${n}: ${entry.screenshotPath}`);
    if (entry.reportPath !== undefined && entry.reportPath !== "") details.push(`ledger report${n}: ${entry.reportPath}`);
    return details;
  });
}

/**
 * US-ATTEST-009 — same-story Review Score entries from `.roll/notes/`:
 * `YYYY-MM-DD-<skill>-<STORY>-<ts>.md` with YAML frontmatter
 * {skill, story, score, verdict, ts} + a prose body. Tolerant reader: files
 * that fail to parse are skipped; no notes ⇒ empty list ⇒ block skipped.
 */
export function readReviewScores(
  projectPath: string,
  storyId: string,
  hrefFromDir?: string,
): ReviewScoreReportEntry[] {
  return readStoryReviewScores(projectPath, storyId, hrefFromDir).map((e) => ({
    skill: e.skill,
    score: e.score,
    verdict: e.verdict,
    ts: e.ts,
    note: e.note,
    ...(e.href !== undefined ? { href: e.href } : {}),
    ...(Object.keys(e.dimensions).length > 0 ? { dimensions: e.dimensions } : {}),
  }));
}

/**
 * US-ATTEST-013 — read the human one-liner + current status straight from the
 * backlog table row (ID-anchored). The description is the "一句人话"; the status
 * cell tells the reviewer where the card sits right now. Lenient: missing
 * backlog / no matching row ⇒ {}.
 */
/** A backlog id cell → its bare id (`[FIX-1](path)` → `FIX-1`, else trimmed). */
function backlogRowId(cell: string): string {
  return cell.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim();
}

export function readBacklogRow(projectPath: string, storyId: string): { description?: string; status?: string } {
  const p = join(projectPath, ".roll", "backlog.md");
  if (!existsSync(p)) return {};
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return {};
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = splitBacklogRow(line).map((c) => c.trim());
    // FIX-1475: select the row by an EXACT id-cell match (link-stripped) — never
    // a substring. A prior `cells.findIndex(c => c.includes(storyId))` fallback
    // picked `US-DEMO-001-legacy` when asked for `US-DEMO-001` (worse when the
    // descendant row sorts first), feeding the wrong description/status into the
    // attestation card context and the zero-TCR routing fallback.
    const at = cells.findIndex((c) => backlogRowId(c) === storyId);
    if (at < 0) continue;
    const description = cells[at + 1];
    const status = cells[at + 2];
    return {
      ...(description !== undefined && description !== "" ? { description } : {}),
      ...(status !== undefined && status !== "" ? { status } : {}),
    };
  }
  return {};
}

/** Join the FIRST `>` blockquote block of a feature md as the spec/方案 summary. */
function extractSummary(featureText: string): string | undefined {
  const quote: string[] = [];
  for (const l of featureText.split("\n")) {
    const m = /^>\s?(.*)$/.exec(l);
    if (m !== null) quote.push(m[1] ?? "");
    else if (quote.length > 0) break;
  }
  const s = quote.join(" ").replace(/\s+/g, " ").trim();
  return s !== "" ? s : undefined;
}

/**
 * US-ATTEST-013 — assemble the self-contained card context: 一句人话 + epic +
 * spec 摘要 + backlog 现状 + 交付链(cycle id). Empty when nothing resolves (trim
 * upstream). The renderer further trims any empty sub-field.
 */
export function buildCardContext(
  projectPath: string,
  featureFile: string,
  storyId: string,
  env: Record<string, string | undefined>,
): CardContext | undefined {
  const row = readBacklogRow(projectPath, storyId);
  const oneLiner =
    row.description !== undefined ? row.description.replace(/\s*depends-on:\S+/gi, "").trim() : undefined;
  let summary: string | undefined;
  try {
    summary = extractSummary(readFileSync(featureFile, "utf8"));
  } catch {
    /* unreadable: skip summary */
  }
  const epic = epicFromFeaturePath(featureFile);
  const cycleId = env.LOOP_CYCLE_ID;
  const ctx: CardContext = {
    ...(oneLiner !== undefined && oneLiner !== "" ? { oneLiner } : {}),
    ...(epic !== null ? { epic } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(row.status !== undefined ? { backlogStatus: row.status } : {}),
    ...(cycleId !== undefined && cycleId !== "" ? { delivery: { cycleId } } : {}),
  };
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * US-ATTEST-013 — pair `before-<stem>.png` with `after-<stem>.png` shots the
 * Gate dropped in the run's screenshots/. Only matched pairs surface; an
 * unmatched before/after is ignored (the renderer needs both sides). Brand-new
 * features carry none → empty list → section trimmed.
 */
export function detectBeforeAfter(runDir: string): BeforeAfterPair[] {
  const dir = join(runDir, "screenshots");
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  } catch {
    return [];
  }
  const pairs: BeforeAfterPair[] = [];
  for (const f of files.slice().sort()) {
    const m = /^before-(.+)\.(png|jpe?g|webp)$/i.exec(f);
    if (m === null) continue;
    const stem = m[1] ?? "";
    const ext = m[2] ?? "";
    const want = `after-${stem}.${ext}`.toLowerCase();
    const after = files.find((x) => x.toLowerCase() === want);
    if (after === undefined) continue;
    pairs.push({
      label: stem,
      before: { kind: "screenshot", label: `改前 ${stem}`, href: `screenshots/${f}` },
      after: { kind: "screenshot", label: `改后 ${stem}`, href: `screenshots/${after}` },
    });
  }
  return pairs;
}

export interface AfterOnlyShot {
  label: string;
  shot: EvidenceRef;
}

/** US-EVID-004: after-only delivery visuals for brand-new surfaces. */
export function detectAfterOnly(runDir: string): AfterOnlyShot[] {
  const dir = join(runDir, "screenshots");
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  } catch {
    return [];
  }
  const lower = new Set(files.map((f) => f.toLowerCase()));
  const shots: AfterOnlyShot[] = [];
  for (const f of files.slice().sort()) {
    const m = /^after-(.+)\.(png|jpe?g|webp)$/i.exec(f);
    if (m === null) continue;
    const stem = m[1] ?? "";
    const ext = m[2] ?? "";
    if (lower.has(`before-${stem}.${ext}`.toLowerCase())) continue;
    shots.push({
      label: stem,
      shot: { kind: "screenshot", label: `改后 ${stem}`, href: `screenshots/${f}` },
    });
  }
  return shots;
}

const USAGE = [
  "Usage: roll attest <story-id> [--deploy-url <url>] [--run-dir <path>]",
  "                   [--capture-terminal | --capture-tmux <session> | --capture-command <cmd>]",
  "                   [--capture-web <url|file>] [--capture-browser <app>] [--capture-region <x,y,w,h>]",
  "  --capture-tmux <session>   self-capture a terminal attached to a tmux session (unattended Gate)",
  "  --capture-command <cmd>    self-capture a terminal running <cmd> (repeatable — one per deliverable_cmd; FIX-339)",
  "  --capture-command-skip <r> record an honest terminal skip for a refused deliverable_cmd (allowlist; repeatable)",
  "  --capture-web <url|file>   self-capture a physical browser-window screenshot of a rendered page (repeatable — one per",
  "                             deliverable_url); no headless / transcript / HTML reproduction fallback",
  "  --capture-browser <app>    GUI lane browser app to drive (default Google Chrome)",
  "  --capture-region <rect>    screencapture -R rectangle (default 0,0,1280,800)",
  "  (screenshot lanes honestly skip off-GUI / without screen-recording permission)",
].join("\n");

/**
 * The AC items for a story, resilient to a content-free stub owner (FIX-226).
 * `findFeatureFile` returns the ID-owned card file, which after migrate-features
 * (US-META-007) may be a stub `spec.md` carrying no `**AC:**` block while the
 * story's real ACs still live in the epic feature file. Walk every candidate
 * (ID-owned first) and return the FIRST non-empty AC set — so a stub that DOES
 * carry its own ACs still wins first (FIX-225 preserved), and an empty stub
 * falls through to the epic file instead of yielding a zero-AC report.
 *
 * FIX-374: an ID-owned card is EITHER the flat `<storyId>.md` OR the card-folder
 * `<storyId>/spec.md` (the same `idOwned` predicate `findFeatureFiles` uses).
 * Both forms own the WHOLE file, so `fileOwned` must hold for either — otherwise
 * a `## Root cause (… FIX-368 sibling)` heading inside a `spec.md` re-attributes
 * the trailing AC block to the mentioned sibling and the report renders zero ACs
 * (the FIX-214 hijack class, here via the directory layout). This keeps the
 * report path aligned with the gate path, which already passes `fileOwned: true`.
 */
function isIdOwnedCard(cand: string, storyId: string): boolean {
  return basename(cand) === `${storyId}.md` || (basename(cand) === "spec.md" && basename(dirname(cand)) === storyId);
}

export function resolveStoryAcItems(projectPath: string, storyId: string): ReturnType<typeof acForStory> {
  for (const cand of findFeatureFiles(projectPath, storyId)) {
    try {
      const items = acForStory(readFileSync(cand, "utf8"), storyId, {
        fileOwned: isIdOwnedCard(cand, storyId),
      });
      if (items.length > 0) return items;
    } catch {
      /* unreadable candidate: skip */
    }
  }
  return [];
}

/** `roll attest <story-id> [--deploy-url <url>] [--capture-tmux <s> | --capture-command <c>]` */
export async function attestCommand(args: string[], deps: AttestDeps = {}): Promise<number> {
  if (args[0] === "audit") return attestAuditCommand(args.slice(1));
  if (skillDispatchActorForCwd(process.cwd()) === "child") {
    process.stderr.write("roll attest: refused in a Skill dispatch child workspace; only the parent DeliveryRun may attest.\n");
    return 1;
  }
  // FIX-329 — the `attest backfill` loophole is removed. Acceptance evidence is
  // produced DURING delivery (the loop's HARD attest:gate renders the report
  // in-cycle; manual deliveries run attest as their Phase 10.6 step), never
  // reconstructed after the fact. A bulk "backfill" let Done cards acquire a
  // report with no real in-delivery evidence — an escape hatch around the truth
  // gate. With it gone, an unattested Done card has no way to pass the release
  // consistency gate except by being attested at delivery time.
  if (args[0] === "backfill") {
    process.stderr.write(
      "[roll] `attest backfill` was removed (FIX-329): attest evidence is produced during delivery, " +
        "not backfilled after the fact. Re-deliver the story (loop or manual Phase 10.6 attest) to earn its report.\n",
    );
    return 1;
  }
  const flagsWithValue = new Set(["--deploy-url", "--run-dir", "--capture-tmux", "--capture-command", "--capture-command-skip", "--capture-region", "--capture-web", "--capture-web-skip", "--capture-browser"]);
  let storyId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (flagsWithValue.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      storyId = arg;
      break;
    }
  }
  if (storyId === undefined || storyId === "") {
    process.stderr.write(USAGE + "\n");
    return 1;
  }
  const flagVal = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // FIX-339 — a flag may REPEAT (multi-surface: several --capture-web / several
  // --capture-command). Collect every value in order.
  const flagVals = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === name) {
        const v = args[i + 1];
        if (v !== undefined) out.push(v);
      }
    }
    return out;
  };
  const deployUrl = flagVal("--deploy-url");
  const explicitRunDir = flagVal("--run-dir");
  const envRunDir = (process.env["ROLL_RUN_DIR"] ?? "").trim();
  const providedRunDir =
    explicitRunDir !== undefined && explicitRunDir !== "" ? explicitRunDir : envRunDir !== "" ? envRunDir : undefined;
  // US-ATTEST-011 — unattended terminal self-capture lane. Driven by the Gate
  // session in a headless cycle; on a non-GUI / no-permission host the lane
  // honestly skips and the report drops the self-capture block (no placeholder).
  const captureTmux = flagVal("--capture-tmux");
  // FIX-339 (AC2/AC3): --capture-command may REPEAT — one declared deliverable_cmd
  // per flag. Each is run in the worktree and its terminal output captured; a
  // multi-command card produces terminal.png, terminal-1.png, … (no name clash).
  const captureCommands = flagVals("--capture-command");
  // FIX-339 (复核 #1): a deliverable_cmd the runner's allowlist REJECTED. It is
  // NEVER run — we only record an honest terminal skip fact (taken:false) so the
  // report discloses the refusal and the attest gate can fail on it.
  const captureCommandSkips = flagVals("--capture-command-skip");
  const captureRegion = flagVal("--capture-region");
  const captureTerminal = args.includes("--capture-terminal") || captureTmux !== undefined || captureCommands.length > 0;
  // FIX-305 — UI/dossier self-capture lane. A UI/dossier card's acceptance is a
  // RENDERED page, so its evidence must be a physical browser-window screenshot,
  // not a headless, transcript-rendered, or HTML-reproduction PNG. Off-GUI hosts
  // record an honest skip.
  // FIX-339 (AC1): --capture-web may REPEAT — one declared deliverable_url per
  // flag. Each url is captured into web.png, web-1.png, … (no name clash).
  const captureWebs = flagVals("--capture-web");
  // FIX-321: when no deliverable web target is declared, the runner passes
  // --capture-web-skip <reason> instead of --capture-web. We record an HONEST web
  // skip (taken:false) — no browser, no hollow dossier shot — which satisfies the
  // visual floor via hasMachineCaptureSkip without faking evidence.
  const captureWebSkip = flagVal("--capture-web-skip");
  const captureBrowser = flagVal("--capture-browser");

  const projectPath = process.cwd();
  const featureFile = findFeatureFile(projectPath, storyId);
  if (featureFile === null) {
    process.stderr.write(`[roll] attest: story ${storyId} not found under .roll/features/\n`);
    process.stderr.write(`[roll] attest：在 .roll/features/ 下找不到 ${storyId}\n`);
    return 1;
  }
  let featureText = "";
  try {
    featureText = readFileSync(featureFile, "utf8");
  } catch {
    featureText = "";
  }

  // AC extraction (FIX-226): walk past a content-free stub owner — the ID-owned
  // card file may be a migrate-features `spec.md` (US-META-007) with no `**AC:**`
  // block, while the story's real ACs still live in the epic feature file. The
  // ID-owned file is still tried first, so US-ATTEST-012 / FIX-214 / FIX-225
  // (a real owner wins; no cross-card hijack) are all preserved.
  const acItems = resolveStoryAcItems(projectPath, storyId);
  if (acItems.length === 0) warn(`no AC block for ${storyId} — report will carry facts only`);

  // run dir + latest symlink (never overwrite history).
  const now = (deps.now ?? ((): Date => new Date()))();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const generatedRunId = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  // US-META-001: deliverables land in the card folder `features/<epic>/<ID>/`
  // (epic via the backlog-generated index, uncategorized fallback). Runs never
  // overwrite history; `latest` symlinks the newest.
  const storyDir = cardArchiveDir(projectPath, storyId);
  // FIX-332 hygiene: an ambient ROLL_RUN_DIR from a parent loop can point at a
  // different story's run frame (e.g. the loop runner's own evidence dir). Using
  // it would leak the current story's report into another card's archive. Only
  // honor a provided run dir whose parent directory matches this story id.
  const safeProvidedRunDir =
    providedRunDir !== undefined && basename(dirname(providedRunDir)) === storyId ? providedRunDir : undefined;
  if (providedRunDir !== undefined && safeProvidedRunDir === undefined) {
    warn(`ignoring mismatched run dir ${providedRunDir} for story ${storyId}`);
  }
  const runDir = safeProvidedRunDir ?? join(storyDir, generatedRunId);
  openEvidenceFrame({ runDir });

  // US-INIT-003b: detect physical_terminal cards — they use kind: "physical_terminal"
  // and NEVER fall back to headless text artifacts.
  const isPhysicalTerminal = ((): boolean => {
    return physicalTerminalFromSpecText(featureText) !== null;
  })();
  const terminalCaptureKind: "terminal" | "physical_terminal" = isPhysicalTerminal ? "physical_terminal" : "terminal";

  // terminal self-capture (US-ATTEST-011): drive the dispatcher's terminal lane
  // into this run's screenshots/ BEFORE evidence sweep, then bridge a TAKEN shot
  // to a report figure. A SKIP (headless / no permission) yields null → the
  // screenshot block is dropped, but FIX-258 records the structured skip fact.
  const selfCaptures: EvidenceRef[] = [];
  const captureFacts: CaptureFact[] = [];
  let commandFact: CaptureCommandFact | null = null;
  if (captureTerminal) {
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    // FIX-339 (AC2/AC3): capture EACH declared command (--capture-command may
    // repeat) plus, when no command is given, a tmux/bare terminal shot. Each
    // gets a distinct stem terminal.png / terminal-1.png / … so a multi-command
    // card never overwrites its own evidence. SECURITY: every command is one the
    // spec DECLARED, wrapped in `cd <worktree> && …` (commandInProject) — only the
    // worktree's own declared commands ever run; no external input reaches here.
    const lanes: Array<{ command?: string }> =
      captureCommands.length > 0 ? captureCommands.map((c) => ({ command: c })) : [{}];
    for (let li = 0; li < lanes.length; li += 1) {
      const lane = lanes[li] ?? {};
      const stem = li === 0 ? "terminal.png" : `terminal-${li}.png`;
      const out = join(runDir, "screenshots", stem);
      let fact: CaptureCommandFact | null = null;
      if (lane.command !== undefined) {
        fact = await captureCommandFact(projectPath, lane.command, deps.capture, {
          runDir,
          stem: li === 0 ? "capture-command" : `capture-command-${li}`,
        });
        if (commandFact === null) commandFact = fact; // first command is the representative capture_command (back-compat)
      }
      let shot: ScreenshotResult =
        fact !== null && fact.exitCode !== 0
          ? {
              kind: terminalCaptureKind,
              out,
              taken: false,
              skipped: `capture command exited ${fact.exitCode}`,
              failed: true,
              error: `capture command exited ${fact.exitCode}${fact.stderrTail !== "" ? `: ${fact.stderrTail}` : ""}${fact.outputDump !== undefined ? ` (full output: ${fact.outputDump.stdout ?? fact.outputDump.stderr ?? ""})` : ""}`,
            }
          : await captureScreenshot(
              {
                kind: terminalCaptureKind,
                out,
                ...(lane.command === undefined && captureTmux !== undefined ? { tmux: captureTmux } : {}),
                ...(lane.command !== undefined ? { command: commandInProject(projectPath, lane.command) } : {}),
                ...(captureRegion !== undefined ? { region: captureRegion } : {}),
              },
              deps.capture ?? {},
            );
      // FIX-392: headless fallback — when a terminal deliverable_cmd ran
      // successfully but the screenshot lane skipped (no GUI / not macOS /
      // headless), promote the command's stdout to a taken text evidence
      // artifact so the attest gate does not deadlock. The stdout text IS
      // the terminal capture.
      // US-INIT-003b: physical_terminal cards NEVER fall back to headless text —
      // physical evidence cannot be satisfied by a transcript dump.
      let refStem = stem;
      if (!shot.taken && fact !== null && fact.exitCode === 0 && !isPhysicalTerminal) {
        refStem = li === 0 ? "terminal-headless.txt" : `terminal-headless-${li}.txt`;
        const txtOut = join(runDir, "screenshots", refStem);
        writeFileSync(txtOut, fact.stdoutTail, "utf8");
        shot = { kind: "terminal", out: txtOut, taken: true };
      }
      captureFacts.push(captureFactFromShot(shot));
      const ref = captureEvidenceRef(shot, `screenshots/${refStem}`);
      if (ref !== null) selfCaptures.push(ref);
      else warn(`terminal self-capture skipped (${refStem}): ${shot.skipped ?? "unknown"}`);
    }
  }
  // FIX-339 (复核 #1): record a terminal skip fact for each REJECTED deliverable_cmd
  // (allowlist refusal). The command is never run — this only留痕 the refusal so
  // the report discloses it and the gate fails loud.
  for (let si = 0; si < captureCommandSkips.length; si += 1) {
    const reason = captureCommandSkips[si] ?? "";
    if (reason === "") continue;
    captureFacts.push({
      kind: "terminal",
      out: join(runDir, "screenshots", si === 0 ? "terminal-rejected.png" : `terminal-rejected-${si}.png`),
      taken: false,
      skipped: reason,
    });
    warn(`deliverable_cmd refused (allowlist): ${reason}`);
  }

  // FIX-305 — UI/dossier web self-capture lane. For a card whose acceptance is a
  // rendered page (the dossier story page, or any url/file the Gate supplies),
  // attest must CAPTURE physical browser-window pixels. Headless Chromium,
  // transcript rendering, and HTML reproduction images are not valid screenshot
  // evidence; off-GUI hosts record an honest skip.
  const realWebs = captureWebs.filter((u) => u !== "");
  if (realWebs.length > 0) {
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    // FIX-339 (AC1): capture EACH declared deliverable_url. Distinct stems
    // web.png / web-1.png / … so a multi-surface card never overwrites a shot.
    for (let wi = 0; wi < realWebs.length; wi += 1) {
      const stem = wi === 0 ? "web.png" : `web-${wi}.png`;
      const out = join(runDir, "screenshots", stem);
      const shot = await captureScreenshot(
        {
          kind: "web",
          out,
          url: realWebs[wi] as string,
          ...(captureBrowser !== undefined && captureBrowser !== "" ? { browser: captureBrowser } : {}),
          ...(captureRegion !== undefined ? { region: captureRegion } : {}),
        },
        deps.capture ?? {},
      );
      captureFacts.push(captureFactFromShot(shot));
      const ref = captureEvidenceRef(shot, `screenshots/${stem}`);
      if (ref !== null) selfCaptures.push(ref);
      else warn(`web self-capture skipped (${stem}): ${shot.skipped ?? "unknown"}`);
    }
  } else if (captureWebSkip !== undefined && captureWebSkip !== "") {
    // FIX-321: honest recorded web skip — no deliverable target declared. NO
    // browser, NO hollow dossier shot. taken:false + a reason makes the visual
    // floor satisfiable (hasMachineCaptureSkip) while disclosing the gap.
    captureFacts.push({ kind: "web", out: join(runDir, "screenshots", "web.png"), taken: false, skipped: captureWebSkip });
    warn(`web self-capture skipped: ${captureWebSkip}`);
  }

  const physicalCaptureReports: PhysicalCaptureReportEntry[] = [];
  const physicalTimeoutMs = deps.rollCapture?.timeoutMs ?? 60_000;
  // US-PHYSICAL-006: capture_fullscreen: true in spec frontmatter explicitly requests display capture
  const captureFullscreen = frontmatterScalar(featureText, "capture_fullscreen") === "true";
  const physicalRequest = physicalScreenshotRequest(
    featureText,
    storyId,
    basename(runDir),
    runDir,
    now.toISOString(),
    physicalTimeoutMs,
    isPhysicalTerminal && captureCommands.length > 0,
    captureFullscreen,
  );
  if (physicalRequest !== null) {
    const captureRoot = deps.rollCapture?.root ?? process.env["ROLL_CAPTURE_HOME"] ?? defaultRollCaptureRoot();
    const readiness = deps.rollCapture?.readiness?.() ?? collectRollCaptureReadiness();
    const provider = deps.rollCapture?.provider ?? new RollCaptureProvider({ root: captureRoot });
    const physical = await runPhysicalScreenshotLane(physicalRequest, readiness, provider, captureRoot, captureFullscreen);
    captureFacts.push(physical.fact);
    physicalCaptureReports.push(physical.report);
    if (physical.selfCapture !== undefined) selfCaptures.push(physical.selfCapture);
    recordAttestCaptureBridgeLink(projectPath, physicalRequest, physical);
    if (!physical.fact.taken) warn(`physical.screenshot ${physical.report.statusChain.join(" → ")}: ${physical.fact.skipped ?? "unknown"}`);
  }

  // US-PHYSICAL-009 — Capture Gateway v2 receipts. Persist each injected receipt
  // through the durable store (dup/no-overwrite guards live there), then fold the
  // accepted ones into the manifest and, for a valid physical receipt, into the
  // report attachment path. This path NEVER consults ROLL_NO_SCREENCAP.
  const captureReceiptFacts: CaptureReceiptFact[] = [];
  const injectedReceipts = deps.rollCapture?.receipts ?? [];
  if (injectedReceipts.length > 0) {
    const captureRoot = deps.rollCapture?.root ?? process.env["ROLL_CAPTURE_HOME"] ?? defaultRollCaptureRoot();
    const store = new RollCaptureReceiptStore({ root: captureRoot });
    for (const { intent, receipt } of injectedReceipts) {
      const persisted = await store.persistReceipt(intent, receipt);
      if (persisted.status === "rejected") {
        warn(`capture v2 receipt ${receipt.requestId} rejected: ${persisted.reason}`);
        continue;
      }
      const accepted = persisted.accepted;
      captureReceiptFacts.push(
        captureReceiptFact(persisted.receipt, intent, { runDir, accepted, captureSetId: persisted.captureSetId }),
      );
      if (accepted && classifyCaptureReceiptV2(persisted.receipt, intent).verdict === "valid") {
        const ref = captureReceiptEvidenceRef(persisted.receipt);
        if (ref !== null) selfCaptures.push(ref);
      }
    }
  }

  // US-EVID-030 — CapturePlanner: for each declared surface, PLAN and DISPATCH
  // every policy-eligible lane through injected executors, record all attempts
  // into one CaptureSet (durable store), and fold accepted images into the
  // manifest + report. Additive/default-off; ROLL_NO_SCREENCAP never gates it.
  const captureSurfaces = deps.rollCapture?.captureSurfaces ?? [];
  // US-EVID-031 — retain each surface's declaration + run result so, once the
  // delivery verdict is known, the EvidenceHealth resolver can separate delivery
  // correctness from visual-evidence health (degraded ≠ rebuild; poisoned/absent
  // block loudly) and the report can render every image under its shared surface.
  const captureRuns: { surface: DeclaredSurface; result: CaptureRunResult }[] = [];
  if (captureSurfaces.length > 0) {
    const captureRoot = deps.rollCapture?.root ?? process.env["ROLL_CAPTURE_HOME"] ?? defaultRollCaptureRoot();
    const store = new RollCaptureReceiptStore({ root: captureRoot });
    const planner = new CapturePlanner({ now: () => now });
    for (const { surface, lanes } of captureSurfaces) {
      const result = await planner.capture(surface, { storyId, runId: basename(runDir), runDir, projectRoot: projectPath }, lanes, store);
      captureRuns.push({ surface, result });
      for (const p of result.persisted) {
        captureReceiptFacts.push(
          captureReceiptFact(p.receipt, p.intent, { runDir, accepted: p.receipt.state === "taken", captureSetId: p.captureSetId }),
        );
      }
      // Attach EVERY retained taken image (physical AND rendered) to the report.
      for (const t of result.taken) {
        if (classifyCaptureReceiptV2(t.receipt, t.intent).verdict === "valid" || t.receipt.captureClass === "rendered") {
          const ref = captureReceiptEvidenceRef(t.receipt);
          if (ref !== null) selfCaptures.push(ref);
        }
      }
      for (const a of result.attempts) {
        if (a.state !== "taken") warn(`capture lane ${a.source} (${a.surfaceId}): ${a.state}${a.reason !== undefined ? ` — ${a.reason}` : ""}`);
      }
    }
  }

  // hard facts.
  const manifest = await collectEvidence({
    storyId,
    projectPath,
    runDir,
    ...(deployUrl !== undefined ? { deployUrl } : {}),
    now: () => now.toISOString(),
    ...(deps.run !== undefined ? { run: deps.run } : {}),
    ...(deps.ghProbe !== undefined ? { ghProbe: deps.ghProbe } : {}),
    captures: captureFacts,
    captureCommand: commandFact,
    ...(captureReceiptFacts.length > 0 ? { captureReceipts: captureReceiptFacts } : {}),
    // US-EVID-033: bind THIS card's delivery-time CI truth (its own PR's checks
    // at the sha they ran on) instead of leaving `ci` — the repo's most recent
    // run — as the card's only CI evidence. Cache-only lookup; absent record ⇒
    // the lane degrades to unknown with a reason.
    ...((): { deliveryRecord?: DeliveryCiRecord } => {
      const rec = resolveCardDeliveryRecord(projectPath, storyId);
      return rec !== undefined ? { deliveryRecord: rec } : {};
    })(),
  });
  // US-EVID-031 — `evidence_health` is folded into the manifest below, AFTER the
  // per-AC items resolve the delivery verdict, so the write is deferred to keep
  // delivery correctness and visual health as ONE consistent machine-readable fact.

  // intent map (AI layer) → report items; absent ⇒ honest all-Claimed.
  // Read-compat (US-META-001): prefer the card folder under the worktree, then
  // fall back to the legacy `verification/<ID>/` dir. FIX-1233: for in-repo .roll
  // (user projects tracking .roll in their main repo), the attest-remediation
  // writes the ac-map under repoCwd (dirname(runDir)), which may differ from the
  // worktree's storyDir. Try dirname(runDir) as an additional fallback so the
  // ac-map is visible to attest regardless of .roll layout.
  const acMap =
    readAcMap(storyDir) ??
    readAcMap(join(projectPath, ".roll", "verification", storyId)) ??
    readAcMap(dirname(runDir));

  // US-ATTEST-016 — outward smoke checks
  // When the evaluation contract declares external-smoke evidence, run the
  // isolated smoke runner and feed results into the outward status resolver.
  // Outward AC statuses override the ac-map (verified-in-simulation or
  // unverified-external must never render as green).
  let outwardOverrides: Map<string, AcStatus> | null = null;
  // US-ATTEST-017 — the prominent outward-verification banner + table. Built
  // from the resolver so the report shows mode + result for every outward AC,
  // never letting simulation-only or skipped smoke read as green.
  let outwardReport: OutwardAcReport[] | null = null;
  try {
    const evaluationContract = parseEvaluationContract(featureText);
    if (evaluationContract !== null) {
      // Collect external-smoke declarations with their AC IDs (proves field)
      const smokeEntries = evaluationContract.expected_evidence
        .filter((item) => item.kind === "external-smoke" && item.outward?.mode === "external-smoke")
        .map((item) => ({ proves: item.proves, outward: item.outward as OutwardSmokeDeclaration }));
      let smokeResults: ReturnType<typeof smokeResultsFromReport> = [];
      if (smokeEntries.length > 0) {
        const smokeDecls = smokeEntries.map((e) => e.outward);
        // Build command → AC ID map for the runner
        const acMap = new Map<string, string>();
        for (const entry of smokeEntries) {
          acMap.set(entry.outward.command, entry.proves);
        }
        // Determine current environment: explicit env var → CI detection → unknown
        const smokeEnv = process.env.ROLL_SMOKE_ENV?.trim() ||
          (process.env.CI !== undefined || process.env.GITHUB_ACTIONS !== undefined ? "ci" : "unknown");
        const smokeDir = join(runDir, "smoke");
        const report = await runOutwardSmoke({
          declarations: smokeDecls,
          acMap,
          currentEnvironment: smokeEnv,
          artifactDir: smokeDir,
        });
        smokeResults = smokeResultsFromReport(report);
        const classification = classifyOutwardStatusForReport(
          { expected_evidence: evaluationContract.expected_evidence },
          smokeResults,
          [], // TODO(US-ATTEST-016): simulation evidence — collect from ac-map "verified-in-simulation" entries
          [], // TODO(US-ATTEST-016): owner attestations — read from owner-attestation records
        );
        if (classification !== null) {
          outwardOverrides = new Map<string, AcStatus>();
          for (const [ac, status] of classification.acStatuses) {
            outwardOverrides.set(ac, outwardAcStatusFromVerification(status));
          }
        }
      }
      // Build the prominent per-AC outward report from every outward
      // declaration (external-smoke AND owner-attested), not just smoke.
      const outwardMap = buildOutwardEvidenceMap({ expected_evidence: evaluationContract.expected_evidence });
      if (Object.keys(outwardMap).length > 0) {
        const resolved = resolveOutwardVerificationStatus(outwardMap, smokeResults, [], []);
        outwardReport = resolved.map((r) => {
          const decl = outwardMap[r.ac];
          const base: OutwardAcReport = {
            ac: r.ac,
            mode: decl?.mode === "owner-attested" ? "owner-attested" : "external-smoke",
            status: r.status,
          };
          if (decl?.mode === "external-smoke") {
            base.environment = decl.environment;
            base.command = decl.command;
          } else if (decl?.mode === "owner-attested") {
            base.approvalRef = decl.approvalRef;
          }
          const detail = r.failureDetail ?? r.note ?? r.smokeArtifact?.summary;
          if (detail !== undefined && detail !== "") base.detail = detail;
          return base;
        });
      }
    }
  } catch (e) {
    warn(`outward smoke check failed: ${e instanceof Error ? e.message : String(e)} — continuing without outward overrides`);
  }

  const siblingBases = runDirHasEvidence(runDir) ? [] : siblingRunDirs(storyDir, runDir);
  const items: AcReportItem[] = acItems.map((ac) => {
    const mapped = acMap?.get(ac.id);
    // US-ATTEST-016 — outward smoke overrides take precedence over ac-map
    const outwardStatus: AcStatus | undefined = outwardOverrides?.get(ac.id);
    const status: AcStatus =
      outwardStatus !== undefined
        ? outwardStatus
        : mapped?.status !== undefined && (STATUSES as readonly string[]).includes(mapped.status)
          ? (mapped.status as AcStatus)
          : "claimed";
    const evidence = (mapped?.evidence ?? [])
      .map((e) => toRef(runDir, storyDir, e, siblingBases))
      .filter((x): x is EvidenceRef => x !== null);
    return {
      id: ac.id,
      text: ac.text,
      status,
      evidence,
      ...(mapped?.note !== undefined ? { note: mapped.note } : {}),
    };
  });

  // US-EVID-031 — resolve visual-evidence health per declared surface, kept
  // STRICTLY separate from the delivery verdict. Delivery correctness is the
  // product/AC result (a `fail` item); a broken capture machine never flips it.
  // degraded-infrastructure publishes visibly marked and is NOT rebuilt;
  // invalid-target / absent-contract BLOCK loudly. The three distinct signals
  // land in the machine-readable manifest (evidence_health), the report, and
  // loop status.
  const deliveryVerdict: "passed" | "failed" = items.some((i) => i.status === "fail") ? "failed" : "passed";
  const evidenceHealthFacts: EvidenceHealthFact[] = [];
  const captureSurfaceReports: CaptureSurfaceReport[] = [];
  for (const { surface, result } of captureRuns) {
    const health = resolveEvidenceHealth({ delivery: deliveryVerdict, contractDeclared: true, run: result });
    const fact = evidenceHealthFact(result.surfaceId, health);
    evidenceHealthFacts.push(fact);
    const decision = evidenceGateDecision(health);
    const images: CaptureSurfaceImage[] = result.taken.map((t) => surfaceImageFromReceipt(t.receipt, runDir));
    captureSurfaceReports.push({
      surfaceId: result.surfaceId ?? surface.declaredUrl,
      visual: health.visual,
      acIds: [...surface.expectedAcIds],
      images,
      ...(health.visual !== "verified" ? { reason: decision.reason } : {}),
    });
    // AC5 — surface the distinct signal to loop status (delivery failure vs
    // evidence degradation vs evidence contract failure). Bilingual, one line each.
    const label = evidenceSignalLabel(fact.category);
    warn(`evidence-health ${fact.surfaceId ?? "(no surface)"} → ${fact.category} [visual=${fact.visual} delivery=${fact.delivery} blocks=${fact.blocksGate} rebuild=${fact.reschedulesBuild}]`);
    warn(`evidence-signal(en): ${label.en}`);
    warn(`evidence-signal(zh): ${label.zh}`);
  }
  if (evidenceHealthFacts.length > 0) manifest.evidence_health = evidenceHealthFacts;
  writeEvidenceJson(manifest, runDir);

  const age = manifest.test_pass.present
    ? manifest.test_pass.age_seconds >= 0
      ? `${manifest.test_pass.age_seconds}s ago`
      : "present"
    : "absent";
  const reviewScores = readReviewScores(projectPath, storyId, runDir);
  const reviewScoreTrend = readReviewScoreTrend(projectPath);
  // US-ATTEST-013 — self-contained card context + before/after comparison.
  const context = buildCardContext(projectPath, featureFile, storyId, process.env);
  const beforeAfter = detectBeforeAfter(runDir);
  const afterOnly = detectAfterOnly(runDir);
  const docGap = detectDocGap(projectPath);
  // US-ATTEST-014 — reverse-look up the delivering cycle and inline its process
  // archive (timeline + signal layer + bounded, redacted transcript). Degrades
  // gracefully: hand-delivered / no-data cards yield undefined (section trimmed).
  const processReaders = deps.process ?? defaultProcessReaders(projectPath, process.env);
  let processArchive: ProcessArchive | undefined;
  try {
    processArchive = buildProcessArchive(storyId, processReaders);
  } catch {
    warn("process archive build failed — report omits the process trace");
    processArchive = undefined;
  }
  const cycleId = processArchive?.cycleId;
  const cycleRoleSummary = cycleId !== undefined ? readCycleRoleSummary(projectPath, cycleId) : undefined;
  let cycleRoleSummaryHref: string | undefined;
  let cycleRoleArtifactHrefs: Record<string, string> | undefined;
  if (cycleRoleSummary !== undefined && cycleId !== undefined) {
    try {
      const summaryPath = join(projectPath, '.roll', 'loop', 'cycle-logs', cycleId, 'summary.json');
      cycleRoleSummaryHref = relative(realpathSync(runDir), realpathSync(summaryPath));
    } catch {
      cycleRoleSummaryHref = undefined;
    }
    cycleRoleArtifactHrefs = {};
    for (const link of buildExecutionCastProjection(cycleRoleSummary).artifactLinks) {
      cycleRoleArtifactHrefs[link.path] = relative(runDir, link.path);
    }
  }
  const html = renderReport({
    storyId,
    title: `${storyId} — Acceptance Evidence`,
    generatedAt: now.toISOString(),
    items,
    facts: { tcrCount: manifest.tcr_commits.length, ciConclusion: manifest.ci.conclusion, testPassAge: age },
    // US-EVID-033 — the card-level delivery-time CI fact leads the closing section.
    ...(manifest.delivery_ci !== undefined ? { deliveryCi: manifest.delivery_ci } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(beforeAfter.length > 0 ? { beforeAfter } : {}),
    ...(afterOnly.length > 0 ? { afterOnly: afterOnly.map((a) => a.shot) } : {}),
    ...(processArchive !== undefined ? { process: processArchive } : {}),
    ...(cycleRoleSummary !== undefined ? { cycleRoleSummary, cycleRoleSummaryHref, cycleRoleArtifactHrefs } : {}),
    ...(docGap !== undefined ? { docGap } : {}),
    ...(reviewScores.length > 0 ? { reviewScores } : {}),
    ...(reviewScoreTrend !== undefined ? { reviewScoreTrend } : {}),
    ...(selfCaptures.length > 0 ? { selfCaptures } : {}),
    ...(physicalCaptureReports.length > 0 ? { physicalCaptures: physicalCaptureReports } : {}),
    ...(captureSurfaceReports.length > 0 ? { captureSurfaces: captureSurfaceReports } : {}),
    ...(captureFacts.some((x) => !x.taken && x.skipped !== undefined)
      ? { captureSkips: captureFacts.filter((x) => !x.taken && x.skipped !== undefined).map((x) => ({ kind: x.kind, out: x.out, skipped: x.skipped ?? "" })) }
      : {}),
    ...((() => { const d = designContractDeliveredEvidence(projectPath, storyId); return d !== "" ? { evidenceDeltaSummary: d } : {}; })()),
    ...(outwardReport !== null && outwardReport.length > 0 ? { outwardVerification: outwardReport } : {}),
  });
  const reviewPath = join(runDir, reviewFileName(storyId));
  writeFileSync(reviewPath, html);
  const reportPath = join(runDir, reportFileName(storyId));
  writeFileSync(reportPath, html);

  // FIX-1233: an empty render (zero AC items, no ac-map) is NOT failed here —
  // a stub spec with no AC block is legitimate (US-META-007) and the attest
  // gate already exempts it (storyHasAcBlock === false ⇒ produced). Failing the
  // render would block that exemption path. The 1246 warn plus the gate's
  // structured content floor (now reading BOTH evidence roots) carry the signal.

  // latest symlink (replace — rm is force-tolerant of absence).
  const latest = join(storyDir, "latest");
  try {
    rmSync(latest, { force: true });
    symlinkSync(relativeFromPhysical(storyDir, runDir), latest);
  } catch {
    warn("latest symlink update failed (report still written)");
  }

  // Render smoke (US-ATTEST-012): the report exists — but is it actually
  // openable? A broken <img> ref or an external CDN asset is a real defect, so
  // (unlike the never-block degrade path) a smoke failure is surfaced as a
  // NON-ZERO exit. The report file stays on disk — evidence is never discarded.
  const smoke = smokeCheckReport(html, (rel) => existsSync(join(runDir, rel)));
  process.stdout.write(handoffLines(currentLang(), relative(projectPath, reviewPath), relative(projectPath, reportPath)).join("\n"));
  // US-V4-001: attest is STORY-SCOPED. It writes only this story's immutable run
  // report (`<run-id>/<ID>-report.html`) + the `latest/` pointer above — nothing
  // else. It deliberately no longer mounts a story `index.html` delivery section,
  // regenerates `.roll/index.json`, or refreshes the global dossier/epic pages.
  // Delivery truth is the story-scoped report + structured evidence + main
  // reconciliation; the global dossier/index/web refresh plane is not a v4
  // delivery side effect. (Was: US-META-006 index.html mount, US-META-009
  // generateIndex self-heal, FIX-231 refreshAggregates.)
  if (!smoke.ok) {
    for (const p of smoke.problems) warn(`render smoke: ${p}`);
    return 2;
  }
  if (commandFact !== null && commandFact.exitCode !== 0) {
    warn(`capture command failed with exit ${commandFact.exitCode}`);
    return 3;
  }
  // Manual host-Delta delivery has no synthetic Cycle.  Once the owner has
  // merged, pulled the integration branch, and this Story-scoped attestation
  // has succeeded, bind that real closure to the retained reservation.  The
  // reconcile tick releases it from the identity-bearing event; this command
  // never releases a lease directly.
  recordHostDeltaAttestationClosure(projectPath, storyId, relative(projectPath, reviewPath));
  return 0;
}
