import { EventBus, parseBacklog, ensureDeliveriesFresh, nodeExecPort, queryStoryDelivery, assessBootstrapArtifacts, readPendingDeliveryEvidenceManifests, type AuditPrEvidence, type FreshnessPort, type PendingDeliveryEvidenceManifest, type StoryDeliveryTruth, type StoryTruth } from "@roll/core";
import {
  GOAL_REVIEW_MODES,
  GOAL_SCHEMA_VERSION,
  classifyStatus,
  parseEventLine,
  parseGoalYaml,
  renderGoalYaml,
  transitionGoal,
  type GoalProgress,
  type GoalReviewMode,
  type GoalSafetyGate,
  type GoalScope,
  type GoalStatus,
  type RollGoal,
} from "@roll/spec";
import { acquireLock, ghRepoSlug, INNER_LOCK_STALE_SEC, isOwnerHeld, prViewMergeInfo, projectIdentity, readLockOwner, releaseLock, remoteUrl, resolveIntegrationBranch } from "@roll/infra";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { GOAL_ALLOWED_CARDS_ENV, GOAL_GUIDED_ENV, runAttemptFromRow } from "../lib/goal-progress.js";
import { projectAgent } from "./agent-list.js";
import { cardArchiveDir } from "../lib/archive.js";
import { deliveryGateDiagnosticsFromRows, storyTruthFromBacklog, type DeliveryGateDiagnostic, type TruthRunRow } from "../lib/truth-adapter.js";
import { runPeerReview, spawnPeerReviewAgent, type SpawnPeerReviewResult } from "./peer.js";
import { guideExternalToolSetup, silentPreinstallChromium } from "../lib/external-tools.js";
import { loopControlRunnerReadout, rollBin, staleLoopRunnerMessage } from "./loop-runner-readout.js";
import { screenLockedCycleIds } from "../runner/screen-lock-events.js";
import { emitBacklogTargetError, resolveBacklogCommandTarget, type BacklogTargetResolver } from "./backlog-target.js";
import { canonicalWorkspaceSelectorIndex, isCanonicalWorkspaceSelectorToken, workspaceSelectorArgs } from "../lib/workspace-selector.js";

/**
 * FIX-906: node fs-backed {@link FreshnessPort} for `ensureDeliveriesFresh`.
 * Goal evaluation now reads the UNIFIED projection (runs + git merges on
 * origin/main) instead of the raw `deliveries.jsonl` cache, so a card merged
 * EXTERNALLY (claude salvage, PR-lane direct merge) is counted delivered —
 * the same truth `roll truth query` reports (FIX-904/905). Mirrors the port in
 * truth.ts; kept local to avoid widening the core export surface.
 */
const nodeFreshnessPort: FreshnessPort = {
  mtimeMs(absPath: string): number | undefined {
    try {
      return statSync(absPath).mtimeMs;
    } catch {
      return undefined;
    }
  },
  readText(absPath: string): string {
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      return "";
    }
  },
  writeText(absPath: string, text: string): void {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, text, "utf8");
  },
};

const GO_LOCK_STALE_SEC = 21_600; // 6h: covers the planned 5h goal window.
const FINAL_REVIEW_TIMEOUT_MS = 300_000;
/** Poll interval while a scheduled cycle holds the inner lock. */
const INNER_LOCK_WAIT_MS = 20_000;
/** Give up waiting for the inner lock after this long (covers a full cycle). */
const INNER_LOCK_WAIT_MAX_MS = 3_600_000;

/**
 * Cross-session dead-loop breaker (REPLACES the removed budget ceiling as the
 * global backstop): after this many CONSECUTIVE whole-goal no-progress cycles
 * (no card delivered) the goal is STOPPED with a loud ALERT — an unmergeable
 * card can never spin indefinitely. Deterministic: the loop halts within K.
 */
const GOAL_NO_PROGRESS_STOP = 3;
/** Per-card consecutive no-progress cycles before the card is skipped. */
const CARD_NO_PROGRESS_SKIP = 2;

interface ProjectId {
  path: string;
  slug: string;
}

export interface RunOnceInput {
  projectPath: string;
  allowedCards?: string[];
  /**
   * FIX-1472: this cycle is a guided/supervisor one-shot (the owner named exact
   * `--cards` on this `go`). Threaded to the run-once child so it runs the
   * scoped card even while autonomous scheduling is paused. See {@link GOAL_GUIDED_ENV}.
   */
  guided?: boolean;
}

export interface StartTmuxInput {
  projectPath: string;
  slug: string;
  args: string[];
  rollBin: string;
  workspaceId?: string;
  runtimeRoot?: string;
  backlogPath?: string;
}

export interface LoopGoDeps {
  identity: () => Promise<ProjectId>;
  pid: () => number;
  nowSec: () => number;
  nowIso: () => string;
  hasTmux: () => boolean;
  startTmux: (input: StartTmuxInput) => boolean;
  /** FIX-289 (AC3): follow the read-only live feed in the foreground (`--attach`). */
  followFeed?: (projectPath: string, rollBin: string) => Promise<void>;
  runOnce: (input: RunOnceInput) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  externalTools?: (surface: "go") => void;
  /**
   * FIX-394 AC2: best-effort Chromium pre-install before the first cycle.
   * Injected so tests never trigger a real `npx playwright install` on the
   * critical loop path (a 5-minute subprocess that would hang the suite).
   */
  preinstallChromium?: () => void;
  prEvidence?: (projectPath: string, storyId: string, backlogStatus: string) => Promise<AuditPrEvidence | undefined>;
  finalReview?: (input: GoalFinalReviewInput) => Promise<GoalFinalReviewResult>;
  resolveTarget?: BacklogTargetResolver;
}

interface GoOptions {
  worker: boolean;
  noTmux: boolean;
  attach: boolean;
  scope: GoalScope;
  scopeSpecified: boolean;
  // FIX-1472 (supervisor review): true ONLY when an explicit `--cards`/`--cards=`
  // flag was passed on THIS invocation. A bare positional token (`go FIX-007`)
  // still forms a cards scope but leaves this false, so it cannot claim the
  // guided paused-bypass. Fail closed — only the flag is the sanctioned gesture.
  cardsFlagSpecified: boolean;
  maxCycles?: number;
  forSeconds?: number;
  reviewMode: GoalReviewMode;
  reviewModeSpecified: boolean;
}

interface RunSummary {
  cycles: number;
  costUsd: number;
}

interface RunRowSnapshot {
  rows: Record<string, unknown>[];
  summary: RunSummary;
}

interface ScopeRow {
  id: string;
  status: string;
}

export interface GoalEvaluation {
  complete: boolean;
  reason: string;
  blockers: string[];
  total: number;
  delivered: number;
}

/**
 * The cross-session progress accounting (Hook 2 — the dead-loop breaker that
 * REPLACES the removed budget ceiling). Hydrated from `goal.progress` at session
 * start so the per-card no-progress streaks AND the whole-goal no-progress
 * counter SURVIVE resume — two back-to-back sessions on the same unmergeable
 * card accumulate the count instead of starting fresh, so a card that can never
 * merge is deterministically stopped within K cycles rather than spinning
 * forever. Synced back onto the goal after every cycle.
 */
interface ProgressState {
  zeroStreaks: Map<string, number>;
  skippedCards: Set<string>;
  /** Consecutive whole-goal no-progress cycles (no card delivered). */
  noProgressCycles: number;
  /**
   * FIX-333: cards THIS go session already delivered (a `published_pending_merge`
   * — PR open, merge handed to the PR lane, or a `delivered`/merged terminal).
   * SESSION-LOCAL and NOT persisted onto the goal: it exists only to stop the
   * SAME session from re-picking a card it just shipped. With worktree isolation
   * a cycle's `✅ Done` lives on the cycle branch, not main, so the main-checkout
   * backlog still reads `📋 Todo` for a just-published card — without this set
   * `allowedCardsForScope` would hand the card straight back to run-once and the
   * worker would open a SECOND PR for the same work (FIX-308 → #759 + #760). The
   * PR lane merges the open PR; once main proves the merge the backlog flips Done
   * and a future session's truth/picker excludes it on its own.
   */
  deliveredCards: Set<string>;
}

/** Hydrate the in-memory progress accounting from the persisted goal. */
function progressFromGoal(goal: RollGoal): ProgressState {
  const p = goal.progress;
  return {
    zeroStreaks: new Map(Object.entries(p?.zeroStreaks ?? {})),
    skippedCards: new Set(p?.skippedCards ?? []),
    noProgressCycles: p?.noProgressCycles ?? 0,
    // Session-local: deliveries by THIS session only — never hydrated/persisted.
    deliveredCards: new Set(),
  };
}

/** Project the in-memory progress accounting back onto the goal for persistence. */
function goalWithProgress(goal: RollGoal, progress: ProgressState): RollGoal {
  const zeroStreaks: Record<string, number> = {};
  for (const [id, n] of progress.zeroStreaks) if (n > 0) zeroStreaks[id] = n;
  const skipped = [...progress.skippedCards];
  const next: GoalProgress = {
    ...(Object.keys(zeroStreaks).length > 0 ? { zeroStreaks } : {}),
    ...(skipped.length > 0 ? { skippedCards: skipped } : {}),
    ...(progress.noProgressCycles > 0 ? { noProgressCycles: progress.noProgressCycles } : {}),
  };
  const hasAny = Object.keys(next).length > 0;
  if (!hasAny) {
    const { progress: _drop, ...rest } = goal;
    return rest;
  }
  return { ...goal, progress: next };
}

export interface GoalFinalReviewInput {
  projectPath: string;
  sessionId: string;
  mode: Exclude<GoalReviewMode, "off">;
  goal: RollGoal;
  evaluation: GoalEvaluation;
  workerAgents: string[];
  timeoutMs: number;
}

export interface GoalFinalReviewResult {
  effectiveMode: "hetero" | "self";
  reviewer: string;
  provider: string;
  commandFamily?: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "TIMEOUT" | "ERROR";
  reason: string;
  findings: string[];
  durationMs?: number;
  transcriptPath?: string;
  evidencePath?: string;
  degradedReason?: string;
}

function realDeps(): LoopGoDeps {
  return {
    identity: () => projectIdentity(),
    pid: () => process.pid,
    nowSec: () => Math.floor(Date.now() / 1000),
    nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    hasTmux: () => {
      try {
        return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    startTmux: startGoTmux,
    followFeed: followGoLiveFeed,
    runOnce: realRunOnce,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    externalTools: guideExternalToolSetup,
    preinstallChromium: () => {
      silentPreinstallChromium();
    },
    prEvidence: defaultPrEvidence,
    resolveTarget: resolveBacklogCommandTarget,
  };
}

async function defaultPrEvidence(projectPath: string, _storyId: string, backlogStatus: string): Promise<AuditPrEvidence | undefined> {
  const pr = /PR#(\d+)/.exec(backlogStatus)?.[1];
  if (pr === undefined) return undefined;
  const slug = ghRepoSlug(await remoteUrl(projectPath));
  if (slug === undefined) return undefined;
  try {
    const info = await prViewMergeInfo(slug, pr);
    if (info === undefined) return undefined;
    return {
      state: info.state,
      ...(info.mergedAt !== undefined ? { mergedAtSec: Date.parse(info.mergedAt) / 1000 } : {}),
    };
  } catch {
    return undefined;
  }
}

function runtimeDir(projectPath: string): string {
  const override = (process.env["ROLL_PROJECT_RUNTIME_DIR"] ?? "").trim();
  return override === "" ? join(projectPath, ".roll", "loop") : override;
}

function backlogPath(projectPath: string): string {
  const override = (process.env["ROLL_WORKSPACE_BACKLOG_PATH"] ?? "").trim();
  return override === "" ? join(projectPath, ".roll", "backlog.md") : override;
}

function goalPath(projectPath: string): string {
  return join(runtimeDir(projectPath), "goal.yaml");
}

function goLockPath(projectPath: string): string {
  return join(runtimeDir(projectPath), "go.lock");
}

function pauseMarkerPath(projectPath: string, slug: string): string {
  return join(runtimeDir(projectPath), `PAUSE-${slug}`);
}

function eventsPath(projectPath: string): string {
  return join(runtimeDir(projectPath), "events.ndjson");
}

function runsPath(projectPath: string): string {
  return join(runtimeDir(projectPath), "runs.jsonl");
}

function parsePorcelainPath(line: string): string {
  const raw = line.length > 3 ? line.slice(3).trim() : line.trim();
  const target = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
  return target.replace(/^"|"$/g, "").replace(/\/$/, "");
}

type BootstrapArtifactInput = string | { status: string; path: string };

function parsePorcelainEntry(line: string): { status: string; path: string } {
  return { status: line.slice(0, 2), path: parsePorcelainPath(line) };
}

function gitDirtyPaths(projectPath: string): BootstrapArtifactInput[] {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: projectPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  // FIX-1272: classify the COMPLETE dirty-path set. The old `.slice(0, 50)`
  // truncated the list BEFORE classification, hiding product-file dirt (and
  // extra evidence) past the cap. Display output may cap paths, but the gate
  // must never decide from a truncated status list. `.roll/loop/**` is the
  // loop's own churning runtime state (events, goal, runs.jsonl, and the
  // evidence manifests themselves) — excluded here so it never counts as dirt.
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map(parsePorcelainEntry)
    .filter((entry) => entry.path !== ".roll/loop" && !entry.path.startsWith(".roll/loop/"));
}

function isBootstrapArtifactPath(path: string): boolean {
  if (path === "AGENTS.md" || path === "CLAUDE.md" || path === ".cursor-rules" || path === "project_rules.md") return true;
  if (path === ".roll" || path.startsWith(".roll/")) return true;
  if (path === ".claude" || path.startsWith(".claude/")) return true;
  return false;
}

function bootstrapArtifactPath(input: BootstrapArtifactInput): string {
  return typeof input === "string" ? input : input.path;
}

export interface BootstrapArtifactClassification {
  /** none = nothing to gate on; bootstrap_only = pure un-owned .roll/convention
   *  pollution (pause); mixed = real product dirt is present (let the cycle
   *  handle it, do not pause on the bootstrap preflight). */
  kind: "none" | "bootstrap_only" | "mixed";
  /** Every dirty path that is NOT a verified runner-owned artifact. */
  files: string[];
  /** Runner-owned artifacts confirmed against a manifest by SHA-256. */
  verified: string[];
  /** FIX-1455: sanctioned append-only runtime ledgers (valid ndjson) — owned, never pauses. */
  runtimeLedger: string[];
  /** Unverified `.roll/**` paths — unknown control-plane pollution. */
  unconfirmed: string[];
  /** Non-`.roll/**` paths — product-file dirt (never manifest-verifiable). */
  external: string[];
}

/**
 * FIX-1272: classify the COMPLETE dirty-path set against the runner-written
 * pending-delivery evidence manifests. The ONLY way a `.roll` path is treated
 * as owned is an exact manifest entry whose current SHA-256 still matches — no
 * path-shape allow-list, no "trust all" switch. Verified artifacts are removed
 * from `files`, so a checkout that holds only verified evidence for an open PR
 * does not pause an unrelated eligible card.
 */
export function classifyBootstrapArtifacts(
  paths: readonly BootstrapArtifactInput[],
  manifests: readonly PendingDeliveryEvidenceManifest[] = [],
  repositoryRoot: string = process.cwd(),
): BootstrapArtifactClassification {
  const dirty = paths.map(bootstrapArtifactPath).filter((p) => p.trim() !== "");
  const assessment = assessBootstrapArtifacts(dirty, manifests, repositoryRoot);
  // FIX-1455: a valid sanctioned runtime ledger is owned exactly like a
  // manifest-verified artifact — removed from `files` so it never pauses the gate.
  const ownedSet = new Set([...assessment.verified, ...assessment.runtimeLedger]);
  const seen = new Set<string>();
  const files: string[] = [];
  for (const p of dirty) {
    if (ownedSet.has(p) || seen.has(p)) continue;
    seen.add(p);
    files.push(p);
  }
  if (files.length === 0) {
    return { kind: "none", files: [], verified: [...assessment.verified], runtimeLedger: [...assessment.runtimeLedger], unconfirmed: [], external: [] };
  }
  // Real product dirt present ⇒ mixed: the cycle (not this preflight) owns it.
  const kind = files.every(isBootstrapArtifactPath) ? "bootstrap_only" : "mixed";
  return {
    kind,
    files,
    verified: [...assessment.verified],
    runtimeLedger: [...assessment.runtimeLedger],
    unconfirmed: [...assessment.unconfirmed],
    external: [...assessment.external],
  };
}

function bootstrapArtifactsMessage(files: readonly string[], verified: readonly string[] = []): string {
  const shown = files.slice(0, 12).join(", ");
  const more = files.length > 12 ? `, ... +${files.length - 12} more` : "";
  const reasonLine = `ALERT reason: bootstrap_artifacts_unconfirmed (${files.length} unconfirmed bootstrap artifact${files.length === 1 ? "" : "s"})`;
  // FIX-1272: name how many artifacts WERE accepted, so operators can see the
  // gate is not all-or-nothing — verified runner evidence passed, only these
  // could not be confirmed.
  const verifiedNote =
    verified.length > 0
      ? `  (${verified.length} runner-owned artifact${verified.length === 1 ? "" : "s"} verified by manifest hash and allowed through)`
      : "";
  const verifiedNoteZh =
    verified.length > 0
      ? `  （另有 ${verified.length} 个 runner 生成的产物已通过 manifest 哈希校验放行）`
      : "";
  return [
    "roll loop go: bootstrap_artifacts_unconfirmed",
    `  ${reasonLine}`,
    `  files: ${shown}${more}`,
    ...(verifiedNote ? [verifiedNote] : []),
    "  Only runner-written evidence recorded in a per-cycle manifest (path + SHA-256) is trusted;",
    "  these files matched no manifest, so confirm their ownership before running builders:",
    "  - commit them to the product repo if they are product truth",
    "  - commit private Roll metadata inside .roll/roll-meta when applicable",
    "  - ignore/externalize them by project policy",
    "  - or clean them up and re-run init/design",
    "  There is no --ignore-dirty or trust-all bypass by design.",
    "  Then rerun: roll loop go",
    "",
    "roll loop go: bootstrap_artifacts_unconfirmed",
    `  ${reasonLine}`,
    ...(verifiedNoteZh ? [verifiedNoteZh] : []),
    "  只有 runner 写入、按 cycle 记录了 manifest（路径 + SHA-256）的证据才会被信任；",
    "  以下文件没有匹配任何 manifest，先确认归属，再启动 builder：",
    "  - 属于产品事实就提交到产品仓",
    "  - 属于私有 Roll 元数据就提交到 .roll/roll-meta",
    "  - 按项目约定 ignore/外置",
    "  - 或清理后重跑 init/design",
    "  设计上没有 --ignore-dirty 或 trust-all 的绕过开关。",
    "  然后再运行：roll loop go",
    "",
  ].join("\n");
}

function parseOptions(args: string[]): GoOptions {
  let scope: GoalScope = { kind: "all" };
  let maxCycles: number | undefined;
  let forSeconds: number | undefined;
  const cards: string[] = [];
  let worker = false;
  let noTmux = false;
  let attach = false;
  let scopeSpecified = false;
  let cardsFlagSpecified = false;
  let reviewMode: GoalReviewMode = "auto";
  let reviewModeSpecified = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (isCanonicalWorkspaceSelectorToken(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--worker") {
      worker = true;
      continue;
    }
    if (arg === "--no-tmux") {
      noTmux = true;
      continue;
    }
    if (arg === "--attach" || arg === "--follow") {
      attach = true;
      continue;
    }
    // FIX-1253: an explicit reset to the full backlog. Scope is the goal's
    // identity and a flagless go inherits it, so once a cards/epic goal exists
    // there was no sanctioned way back to "all". `--all` marks the scope as
    // specified-this-run so applyRunOptions overwrites the persisted narrow
    // scope instead of carrying it over.
    if (arg === "--all") {
      scope = { kind: "all" };
      scopeSpecified = true;
      continue;
    }
    if (arg === "--epic") {
      const epic = args[i + 1]?.trim() ?? "";
      if (epic !== "") {
        scope = { kind: "epic", epic };
        scopeSpecified = true;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--epic=")) {
      const epic = arg.slice("--epic=".length).trim();
      if (epic !== "") {
        scope = { kind: "epic", epic };
        scopeSpecified = true;
      }
      continue;
    }
    if (arg === "--max-cycles") {
      maxCycles = parseNonNegativeInteger(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-cycles=")) {
      maxCycles = parseNonNegativeInteger(arg.slice("--max-cycles=".length));
      continue;
    }
    if (arg === "--for") {
      forSeconds = parseRequiredDurationSeconds(args[i + 1], "--for");
      i += 1;
      continue;
    }
    if (arg.startsWith("--for=")) {
      forSeconds = parseRequiredDurationSeconds(arg.slice("--for=".length), "--for");
      continue;
    }
    if (arg === "--review") {
      reviewMode = parseReviewMode(args[i + 1]);
      reviewModeSpecified = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--review=")) {
      reviewMode = parseReviewMode(arg.slice("--review=".length));
      reviewModeSpecified = true;
      continue;
    }
    if (arg === "--cards") {
      cards.push(...parseCards(args[i + 1]));
      cardsFlagSpecified = true;
      i += 1;
      continue;
    }
    if (arg.startsWith("--cards=")) {
      cards.push(...parseCards(arg.slice("--cards=".length)));
      cardsFlagSpecified = true;
      continue;
    }
    if (!arg.startsWith("-")) cards.push(...parseCards(arg));
  }

  if (cards.length > 0) {
    scope = { kind: "cards", cards };
    scopeSpecified = true;
  }
  return {
    worker,
    noTmux,
    attach,
    scope,
    scopeSpecified,
    cardsFlagSpecified,
    reviewMode,
    reviewModeSpecified,
    ...(maxCycles !== undefined ? { maxCycles } : {}),
    ...(forSeconds !== undefined ? { forSeconds } : {}),
  };
}

function hasHelpArg(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * FIX-1472: a guided/supervisor one-shot — the owner named EXACT cards on THIS
 * invocation (`roll loop go --cards X`). It is an explicit foreground supervisor
 * action, NOT autonomous scheduling, so it runs the named card(s) even while the
 * loop is PAUSED (pause stops autonomous scheduling only). `go` never installs a
 * scheduler / launchd / fallback process, and the `cards` scope filters the
 * picker to the named ids (no backlog scan, no other-card selection); the run
 * stays bounded by `--max-cycles` and by the scope itself. Fail closed: only an
 * explicit, non-empty `--cards` FLAG passed THIS RUN qualifies — a missing,
 * inherited, positional-token, `--all`, or `--epic` scope stays autonomous and
 * keeps honoring the pause marker. A bare positional token (`go FIX-007`) forms
 * a cards scope but is NOT the sanctioned supervisor gesture, so it does not
 * bypass the pause (`cardsFlagSpecified` gates that).
 */
function isGuidedRun(opts: GoOptions): boolean {
  return (
    opts.cardsFlagSpecified &&
    opts.scopeSpecified &&
    opts.scope.kind === "cards" &&
    opts.scope.cards.length > 0
  );
}

function loopGoHelp(): string {
  return [
    "Usage: roll loop go [--workspace <id|path>] [--epic <name>|--cards <ids>|--all] [--for <duration>] [--max-cycles <n>] [--review <auto|hetero|self|off>] [--attach] [--no-tmux]",
    "  Chain goal-mode cycles until the scoped backlog is complete, paused, or capped.",
    "  按 goal 范围连续执行 cycle，直到完成、暂停或达到上限。",
    "",
    "Options:",
    "  --workspace <id|path> Bind this goal session to one Workspace runtime and backlog.",
    "  --epic <name>       Limit the goal to one epic.",
    "  --cards <ids>       Limit the goal to comma/space separated card IDs.",
    "  --all               Reset the goal scope to the full Todo backlog (undo a prior --epic/--cards goal).",
    "  --for <duration>    Stop after the current cycle once the wall-clock box is reached (default unit: minutes).",
    "  --max-cycles <n>    Stop after n cycles in this go session.",
    "  --review <mode>     Final review policy before completion: auto, hetero, self, or off.",
    "  --attach, --follow  Start the session, then follow the read-only live feed in the foreground (Ctrl-C stops the view, not the loop).",
    "  --no-tmux           Run in the current process instead of starting a tmux session.",
    "",
    "Limits are explicit per run (FIX-279):",
    "  --max-cycles / --for apply to THIS go only. Omit one and it is unset for this run — never inherited from a prior session.",
    "  --max-cycles / --for 仅对本次 go 生效；省略即本轮不设限，绝不沿用上次会话的上限。",
    "  Scope (--epic/--cards) and --review still persist when unspecified — they are the goal's identity, not a per-run safety knob.",
    "  范围 (--epic/--cards) 与 --review 省略时仍沿用——它们是 goal 的身份，不是每次的安全旋钮。",
    "  The startup banner shows the EFFECTIVE scope; an inherited scope is flagged so a flagless go can never silently narrow. Pass --all to reset to the full backlog.",
    "  启动横幅显示生效的 scope；沿用的 scope 会被标注，flagless go 绝不静默收窄。用 --all 重置回全量。",
    "",
    "Guided one-shot while paused (FIX-1472):",
    "  An explicit `roll loop go --cards X` runs the named card(s) even while `roll loop pause` is in effect — it is a supervisor action, not autonomous scheduling. It installs no scheduler and picks no other card; bound it with --max-cycles.",
    "  显式的 `roll loop go --cards X` 即使在 `roll loop pause` 生效时也会执行指定卡——这是 Supervisor 手动动作，不是自主排程。它不安装排程、不选别的卡；用 --max-cycles 限定次数。",
    "  Pause still stops autonomous scheduling; only an explicitly-named --cards scope bypasses it (a flagless/inherited/--all/--epic go keeps honoring the pause).",
    "  pause 仍然停止自主排程；只有本次显式指定的 --cards 范围才会绕过（flagless/沿用/--all/--epic 的 go 仍遵守暂停）。",
    "",
    "Progress guardrails (the loop stops on NO PROGRESS, not on cost):",
    "  productivity floor  A cycle whose agent EXECUTED but produced 0 commits and no delivery is a `gave_up` terminal — alerted on the first occurrence (no streak).",
    "  dead-loop breaker   A card is skipped after consecutive no-progress cycles; the whole goal STOPS after K consecutive no-progress cycles (a loud ALERT) — an unmergeable card can never spin forever.",
    "  timebox             Stops only at a cycle boundary and records a goal:gate_tripped event.",
    "",
    "Review modes:",
    "  auto    Default. Try heterogeneous reviewers in ranked order; degrade to self review only after every heterogeneous candidate fails or when no other provider is installed.",
    "  hetero  Strict-diversity mode: require an alternate-provider reviewer; unavailable reviewers block completion.",
    "  self    Allow final review by the same provider family.",
    "  off     Skip final review and record a goal:final_review SKIPPED event.",
    "",
  ].join("\n");
}

function parseReviewMode(value: string | undefined): GoalReviewMode {
  const mode = (value ?? "").trim();
  if (GOAL_REVIEW_MODES.includes(mode as GoalReviewMode)) return mode as GoalReviewMode;
  throw new Error(`roll loop go: --review must be one of ${GOAL_REVIEW_MODES.join(", ")}`);
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const n = parseNonNegativeNumber(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function parseDurationSeconds(value: string | undefined): number | undefined {
  const raw = (value ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = match[2] ?? "m";
  if (unit === "ms") return amount / 1000;
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 3600;
  return amount * 86_400;
}

function parseRequiredDurationSeconds(value: string | undefined, flag: string): number {
  const seconds = parseDurationSeconds(value);
  if (seconds === undefined) throw new Error(`roll loop go: ${flag} must be a duration like 30m, 5h, or 1d`);
  return seconds;
}

function parseCards(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** tmux session name for a project slug. */
function goSessionName(slug: string): string {
  return `roll-loop-${slug}`;
}

/** Shell snippet for the read-only watch window / foreground follow. */
function watchCommand(projectPath: string, slug: string, rollBin: string): string {
  return `cd ${shellQuote(projectPath)} && printf 'roll goal · ${slug}\\n' && ROLL_BIN=${shellQuote(rollBin)} ${shellQuote(rollBin)} loop watch --since all`;
}

/**
 * FIX-289: an injectable view of the session's tmux state so the command
 * planner is pure and unit-testable. `realStartGoTmux` probes tmux for it.
 */
export interface GoTmuxState {
  /** Does the session `roll-loop-<slug>` already exist? */
  sessionExists: boolean;
  /** Does that session already have a window named `watch`? */
  watchWindowExists: boolean;
}

/**
 * FIX-289 (AC2): the tmux argv plan for starting a go cycle window, given the
 * current session state. The `watch` (read-only live feed) window is created
 * whenever it is MISSING — not only on first session creation — so attaching to
 * a REUSED session still lands on a live feed instead of the raw worker window.
 */
export function planGoTmuxCommands(input: StartTmuxInput, state: GoTmuxState): string[][] {
  const session = goSessionName(input.slug);
  const watch = watchCommand(input.projectPath, input.slug, input.rollBin);
  const workerArgs = input.args
    .filter((arg) => arg !== "--worker" && arg !== "--no-tmux" && arg !== "--attach" && arg !== "--follow")
    .concat("--worker")
    .map(shellQuote)
    .join(" ");
  const workspaceEnv = input.workspaceId === undefined
    ? ""
    : ` ROLL_WORKSPACE=${shellQuote(input.workspaceId)} ROLL_PROJECT_RUNTIME_DIR=${shellQuote(input.runtimeRoot ?? "")} ROLL_WORKSPACE_BACKLOG_PATH=${shellQuote(input.backlogPath ?? "")}`;
  const command = `cd ${shellQuote(input.projectPath)} && ROLL_LOOP_GO_WORKER=1 ROLL_LOOP_NO_TMUX=1 ROLL_NO_SCREENCAP=1${workspaceEnv} ROLL_BIN=${shellQuote(input.rollBin)} ${shellQuote(input.rollBin)} loop go ${workerArgs}`;
  const plan: string[][] = [];
  if (!state.sessionExists) {
    plan.push(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-n", "watch", watch]);
  } else if (!state.watchWindowExists) {
    // Session reused but its watch window is gone (closed, or never created by
    // an older go): recreate it so observers always have the live feed.
    plan.push(["new-window", "-d", "-t", session, "-n", "watch", watch]);
  }
  plan.push(["new-window", "-d", "-t", session, "-n", "go", command]);
  return plan;
}

/** Probe tmux for the current session/watch-window state of a slug. */
function probeGoTmuxState(slug: string): GoTmuxState {
  const session = goSessionName(slug);
  const sessionExists = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
  if (!sessionExists) return { sessionExists: false, watchWindowExists: false };
  const listed = spawnSync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { encoding: "utf8" });
  const windows = listed.status === 0 ? String(listed.stdout ?? "").split("\n").map((w) => w.trim()) : [];
  return { sessionExists: true, watchWindowExists: windows.includes("watch") };
}

function startGoTmux(input: StartTmuxInput): boolean {
  const session = goSessionName(input.slug);
  try {
    const plan = planGoTmuxCommands(input, probeGoTmuxState(input.slug));
    let goStarted = false;
    for (const argv of plan) {
      const ok = spawnSync("tmux", argv, { stdio: "ignore" }).status === 0;
      if (argv[0] === "new-window" && argv.includes("go") && argv[argv.length - 1]?.startsWith("cd ")) goStarted = ok;
    }
    return goStarted;
  } catch {
    return false;
  }
}

/**
 * FIX-289 (AC3): follow the read-only live feed in the foreground. Ctrl-C here
 * stops only the VIEW — the cycle keeps running in its detached tmux window.
 */
function followGoLiveFeed(projectPath: string, rollBin: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd = rollBin.endsWith(".js") || rollBin.endsWith(".mjs") ? process.execPath : rollBin;
    const args = rollBin.endsWith(".js") || rollBin.endsWith(".mjs") ? [rollBin, "loop", "watch", "--since", "all"] : ["loop", "watch", "--since", "all"];
    const watch = spawn(cmd, args, { cwd: projectPath, stdio: ["ignore", "inherit", "inherit"] });
    const finish = (): void => {
      try {
        watch.kill("SIGTERM");
      } catch {
        /* gone */
      }
      process.removeListener("SIGINT", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    watch.on("exit", finish);
    watch.on("error", finish);
  });
}

/**
 * Build the env for the detached `roll loop run-once` child. Pure and exported
 * so the fail-closed guarantees are unit-testable without spawning a process.
 *
 * FIX-1472 (supervisor review): the guided flag is set EXPLICITLY on every
 * invocation — "1" only when THIS call is guided, "0" otherwise — so an ambient
 * `ROLL_LOOP_GO_GUIDED=1` inherited from the parent env can NEVER leak into an
 * unguided child and let an autonomous invocation (which still carries an
 * allowed-card env, e.g. `go --all`) bypass the PAUSE marker. The explicit key
 * comes after the `...base` spread, so it always wins.
 */
export function buildRunOnceChildEnv(input: RunOnceInput, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ROLL_LOOP_GO_CHILD: "1",
    // FIX-1022: unattended go-driver child must never trigger the macOS
    // screencapture TCC prompt (isTTY is unreliable under PTY wrapping).
    ROLL_NO_SCREENCAP: base["ROLL_NO_SCREENCAP"] ?? "1",
    ...(input.allowedCards !== undefined ? { [GOAL_ALLOWED_CARDS_ENV]: input.allowedCards.join(",") } : {}),
    // FIX-1472: guided is set on EVERY call (never conditionally spread) so an
    // inherited ambient "1" cannot survive into an unguided child. Fail closed
    // to "0" — isGuidedRunOnce treats anything but "1" as not guided.
    [GOAL_GUIDED_ENV]: input.guided === true ? "1" : "0",
  };
}

function realRunOnce(input: RunOnceInput): Promise<number> {
  const bin = rollBin();
  const cmd = bin.endsWith(".js") || bin.endsWith(".mjs") ? process.execPath : bin;
  const args = cmd === process.execPath ? [bin, "loop", "run-once"] : ["loop", "run-once"];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: input.projectPath,
      detached: true,
      env: buildRunOnceChildEnv(input),
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function writeGoal(path: string, goal: RollGoal): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderGoalYaml(goal), "utf8");
  renameSync(tmp, path);
}

function readGoal(path: string): RollGoal | undefined {
  if (!existsSync(path)) return undefined;
  return parseGoalYaml(readFileSync(path, "utf8"));
}

/**
 * Preserve a terminal goal before a new `go` invocation replaces goal.yaml.
 * The archive name is stable for the same goal, so a crash after archiving but
 * before replacing goal.yaml retries without duplicating the historical record.
 */
function archiveCompletedGoal(path: string, goal: RollGoal): string {
  const archiveDir = join(dirname(path), "goal-archive");
  mkdirSync(archiveDir, { recursive: true });
  const rendered = renderGoalYaml(goal);
  const stem = `goal-${goal.createdAt.replace(/[^0-9]/g, "") || "unknown"}`;
  let candidate = join(archiveDir, `${stem}.yaml`);
  let suffix = 1;
  while (existsSync(candidate)) {
    try {
      if (readFileSync(candidate, "utf8") === rendered) return join("goal-archive", `${stem}${suffix === 1 ? "" : `-${suffix - 1}`}.yaml`);
    } catch {
      // Treat an unreadable candidate as occupied and preserve the completed
      // goal under a distinct immutable archive name.
    }
    candidate = join(archiveDir, `${stem}-${suffix}.yaml`);
    suffix += 1;
  }
  const archivePath = join("goal-archive", candidate.slice(archiveDir.length + 1));
  const tmp = `${candidate}.tmp-${process.pid}`;
  writeFileSync(tmp, rendered, "utf8");
  renameSync(tmp, candidate);
  return archivePath;
}

function createGoal(opts: GoOptions, at: string): RollGoal {
  return {
    schema: GOAL_SCHEMA_VERSION,
    scope: opts.scope,
    review: { mode: opts.reviewMode },
    limits: {
      ...(opts.maxCycles !== undefined ? { maxCycles: opts.maxCycles } : {}),
      ...(opts.forSeconds !== undefined ? { maxHours: opts.forSeconds / 3600 } : {}),
    },
    status: "active",
    usage: { cycles: 0, costUsd: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

function summarizeRuns(path: string): RunSummary {
  return readRunSnapshot(path).summary;
}

function readRunSnapshot(path: string): RunRowSnapshot {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { rows: [], summary: { cycles: 0, costUsd: 0 } };
  }
  const rows: Record<string, unknown>[] = [];
  let cycles = 0;
  let costUsd = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    rows.push(row);
    cycles += 1;
    // Per-row cost is still RECORDED on every runs row (cost_usd /
    // cost_effective_usd); we only sum the KNOWN cost here to feed the
    // session-total display. A row with no parseable cost is silently skipped
    // (its truthful `usage_unknown:true` flag lives on the row itself) — there
    // is no budget gate to trip, so the unknown-row counter is gone.
    const effective = typeof row["cost_effective_usd"] === "number" && Number.isFinite(row["cost_effective_usd"]) ? row["cost_effective_usd"] : undefined;
    const estimated = typeof row["cost_usd"] === "number" && Number.isFinite(row["cost_usd"]) ? row["cost_usd"] : undefined;
    if (effective !== undefined || estimated !== undefined) {
      costUsd += effective ?? estimated ?? 0;
    }
  }
  return { rows, summary: { cycles, costUsd } };
}

function readBacklogRows(projectPath: string): ScopeRow[] {
  try {
    return parseBacklog(readFileSync(backlogPath(projectPath), "utf8")).map((row) => ({
      id: row.id,
      status: row.status,
    }));
  } catch {
    return [];
  }
}

function readStoryIndex(projectPath: string): Record<string, string> {
  try {
    const obj = JSON.parse(readFileSync(join(projectPath, ".roll", "index.json"), "utf8")) as { stories?: unknown };
    if (typeof obj.stories !== "object" || obj.stories === null || Array.isArray(obj.stories)) return {};
    const out: Record<string, string> = {};
    for (const [id, epic] of Object.entries(obj.stories)) {
      if (typeof epic === "string" && epic !== "") out[id] = epic;
    }
    return out;
  } catch {
    return {};
  }
}

function rowsForScope(projectPath: string, scope: GoalScope): ScopeRow[] {
  const rows = readBacklogRows(projectPath);
  if (scope.kind === "cards") {
    const wanted = new Set(scope.cards);
    return rows.filter((row) => wanted.has(row.id));
  }
  if (scope.kind === "epic") {
    const index = readStoryIndex(projectPath);
    return rows.filter((row) => index[row.id] === scope.epic);
  }
  return rows.filter((row) => classifyStatus(row.status) === "todo");
}

function allowedCardsForScope(projectPath: string, goal: RollGoal, progress: ProgressState): string[] {
  return rowsForScope(projectPath, goal.scope)
    .map((row) => row.id)
    // FIX-333: never hand back a card this session already skipped OR already
    // delivered (published_pending_merge / merged). A delivered card whose Done
    // has not yet reached main must not be re-picked — that is the double-PR bug.
    .filter((id) => !progress.skippedCards.has(id) && !progress.deliveredCards.has(id));
}

function allScopeCardsSkipped(projectPath: string, goal: RollGoal, progress: ProgressState): boolean {
  const rows = rowsForScope(projectPath, goal.scope);
  return rows.length > 0 && rows.every((row) => progress.skippedCards.has(row.id));
}

function readRunRows(projectPath: string): TruthRunRow[] {
  const runsPath = join(runtimeDir(projectPath), "runs.jsonl");
  let content = "";
  try {
    content = readFileSync(runsPath, "utf8");
  } catch {
    return [];
  }
  const rows: TruthRunRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as TruthRunRow);
    } catch {
      /* ignore malformed historical rows */
    }
  }
  return rows;
}

function deliveryGateStopDetail(diagnostic: DeliveryGateDiagnostic): string {
  const suffix = diagnostic.ciRunUrl !== undefined ? `:${diagnostic.ciRunUrl}` : "";
  return `${diagnostic.kind}:${diagnostic.storyId}${suffix}`;
}

export function deliveryGateStopDetails(projectPath: string, nowSec: number): string[] {
  return deliveryGateDiagnosticsFromRows(readRunRows(projectPath), { nowSec }).map(deliveryGateStopDetail);
}

/**
 * FIX-333: every scope card is now SETTLED for this session — each is either
 * skipped (no-progress) or already delivered in-flight (published_pending_merge,
 * PR open and handed to the PR lane). There is nothing left for THIS session to
 * pick, so it ends cleanly (the PR lane merges the open PRs) rather than spinning
 * on a card it already shipped or pausing as a false no-progress. Distinct from
 * {@link allScopeCardsSkipped}: at least one card here was DELIVERED, not stuck.
 */
function allScopeCardsSettled(projectPath: string, goal: RollGoal, progress: ProgressState): boolean {
  const rows = rowsForScope(projectPath, goal.scope);
  if (rows.length === 0) return false;
  return rows.every((row) => progress.skippedCards.has(row.id) || progress.deliveredCards.has(row.id));
}

function alertPath(projectPath: string, slug: string): string {
  return join(runtimeDir(projectPath), `ALERT-${slug}.md`);
}

function appendGoalAlert(projectPath: string, slug: string, storyId: string, cycleId: string | undefined, streak: number, at: string): void {
  const path = alertPath(projectPath, slug);
  mkdirSync(dirname(path), { recursive: true });
  const cycleLine = cycleId === undefined ? "" : ` cycle=${cycleId}`;
  const verb = streak >= CARD_NO_PROGRESS_SKIP ? "skipped (no-progress streak)" : "no progress";
  appendFileSync(path, `[${at}] ALERT goal card ${verb}: ${storyId}${cycleLine} no_progress_cycles=${streak}\n`, "utf8");
}

/**
 * Hook 2 — the HARD GLOBAL breaker ALERT: K consecutive whole-goal no-progress
 * cycles STOP the goal. Distinct, loud, and carries a remediation hint so the
 * owner knows the loop halted itself rather than spun forever.
 */
function appendBreakerAlert(projectPath: string, slug: string, cycles: number, at: string): void {
  const path = alertPath(projectPath, slug);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `[${at}] ALERT goal STOPPED: ${cycles} consecutive no-progress cycles (dead-loop breaker). ` +
      `Remediation: a card cannot be delivered by re-running — check the spec/dependencies, split or hold the card, then resume.\n`,
    "utf8",
  );
}

/**
 * FIX-280 (AC3): a final-review crash is an ALERT, not a silent generic ERROR.
 * Write the real failure reason to the session ALERT file so it surfaces in the
 * session-end terminal reason ({@link latestAlertSummary} / {@link noCycleTerminalReason}).
 */
function appendReviewAlert(projectPath: string, slug: string, session: string, reason: string, at: string): void {
  const path = alertPath(projectPath, slug);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `[${at}] ALERT goal final review failed: session=${session} reason=${reason.replace(/\s+/g, " ").slice(0, 200)}\n`, "utf8");
}

function appendScopeMismatchAlert(projectPath: string, slug: string, expected: readonly string[], actual: readonly string[], at: string): void {
  const path = alertPath(projectPath, slug);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `[${at}] ALERT goal scope mismatch: run-once picked out-of-scope card ${actual.join(", ")}; expected only ${expected.join(", ")}\n`,
    "utf8",
  );
}

function outOfScopeStoryIds(rows: readonly Record<string, unknown>[], allowedCards: readonly string[] | undefined): string[] {
  if (allowedCards === undefined || allowedCards.length === 0) return [];
  const allowed = new Set(allowedCards);
  return [
    ...new Set(
      rows
        .map((row) => row["story_id"])
        .filter((storyId): storyId is string => typeof storyId === "string" && storyId !== "" && !allowed.has(storyId)),
    ),
  ].sort();
}

/**
 * Hook 2 — fold a cycle's appended runs rows into the cross-session progress
 * accounting. A delivery resets that card's streak (and signals whole-goal
 * progress this cycle); a `gave_up`/zero-delivery terminal increments the card's
 * streak. ALERT on the FIRST no-progress (no 2-hit silence); skip the card once
 * its streak reaches {@link CARD_NO_PROGRESS_SKIP}. The whole-goal
 * `noProgressCycles` counter resets the moment any card delivers and otherwise
 * increments for ANY cycle that appended >=1 runs row without delivering —
 * including rows that are not parseable as a known terminal (no `tcr_count`,
 * no delivery evidence, or no `story_id`). It is the FAIL-SAFE input to the
 * hard global breaker (checked in the gate slot the budget gate vacated): a row
 * the per-card loop cannot attribute still counts against the airtight backstop.
 */
function updateProgressFromRows(
  projectPath: string,
  slug: string,
  session: string,
  rows: Record<string, unknown>[],
  progress: ProgressState,
  deps: LoopGoDeps,
  bus: EventBus,
): void {
  let delivered = false;
  let accountableRows = 0;
  const lockedCycleIds = screenLockedCycleIds(eventsPath(projectPath));
  for (const row of rows) {
    if (row["status"] === "waiting_capacity" || row["outcome"] === "waiting_capacity") continue;
    const cycleId = typeof row["cycle_id"] === "string" ? row["cycle_id"] : typeof row["cycleId"] === "string" ? row["cycleId"] : undefined;
    // FIX-1268b: a lock-screen wait is an externally imposed pause, not a
    // failed attempt. Its event is durable and cycle-bound, so only that exact
    // idle row is exempt; malformed or unrelated rows still fail loud.
    if (cycleId !== undefined && lockedCycleIds.has(cycleId)) continue;
    accountableRows += 1;
    const attempt = runAttemptFromRow(row);
    if (attempt === undefined || !attempt.known) continue;
    if (!attempt.zeroDelivery) {
      progress.zeroStreaks.delete(attempt.storyId);
      // FIX-333: a delivery (incl. published_pending_merge — PR open, not yet
      // merged) marks the card in-flight for THIS session so the next cycle's
      // allowed-cards excludes it. Re-picking a card the main backlog still
      // shows as Todo (worktree-isolated Done not yet on main) is what opened a
      // duplicate PR for the same work.
      progress.deliveredCards.add(attempt.storyId);
      delivered = true;
      continue;
    }
    const nextCount = (progress.zeroStreaks.get(attempt.storyId) ?? 0) + 1;
    progress.zeroStreaks.set(attempt.storyId, nextCount);
    // ALERT on the FIRST no-progress terminal for a card (no 2-hit streak): the
    // very first expensive idle/gave_up cycle is now loud, not silent.
    appendGoalAlert(projectPath, slug, attempt.storyId, attempt.cycleId, nextCount, deps.nowIso());
    if (nextCount < CARD_NO_PROGRESS_SKIP || progress.skippedCards.has(attempt.storyId)) continue;
    progress.skippedCards.add(attempt.storyId);
    bus.appendEvent(eventsPath(projectPath), {
      type: "goal:card_skipped",
      sessionId: session,
      storyId: attempt.storyId,
      reason: "no_progress_streak",
      zeroDeliveries: nextCount,
      ...(attempt.cycleId !== undefined ? { cycleId: attempt.cycleId } : {}),
      ts: deps.nowSec(),
    });
  }
  // Whole-goal no-progress accounting (feeds the hard breaker) — FAIL-SAFE: any
  // delivery this cycle resets the streak; ANY cycle that appended >=1 runs row
  // but delivered NOTHING increments it, whether or not the row was parseable as
  // a KNOWN no-progress terminal. This closes the spin-hole: a row with no
  // `tcr_count`/evidence (or no `story_id`) is `known:false`/`undefined` and is
  // skipped by the per-card loop above, yet it must still count against the
  // global breaker — otherwise a cycle that keeps appending such rows spins
  // forever (cycles increase, so the no-cycle-terminal backstop never fires).
  // A cycle that appended NO row leaves the counter unchanged (that case is
  // broken by the `after.summary.cycles <= before.summary.cycles` backstop).
  // Invariant: every cycle either appends no row (backstop breaks) OR appends a
  // row → delivers (reset) or doesn't (increment → breaker STOPS at K). No
  // infinite spin is possible regardless of row parseability.
  if (delivered) progress.noProgressCycles = 0;
  else if (accountableRows > 0) progress.noProgressCycles += 1;
}

/**
 * FIX-337 (AC5): a card is IN-FLIGHT when its PR is open but not yet merged —
 * the cycle-ledger `pending_merge` / `published_pending_merge` analog at the
 * story level. Detected from the PR evidence the gatherer resolved (state OPEN)
 * OR a `PR#N` annotation on the backlog status cell (a PR was opened) for a card
 * the merge truth does NOT yet confirm delivered. A MERGED PR is delivery, not
 * in-flight, so it is excluded here (it counts via `truth.delivered`).
 */
/**
 * US-TRUTH-017: isCardInFlight now accepts structured delivery truth as the
 * preferred input. When {@link deliveryTruth} is present, the lifecycleState
 * field ("pending_merge" | "ci_red") replaces the deprecated /PR#\d+/ regex parse
 * of the backlog status string.
 *
 * Two-step migration (AC3):
 *   1. Add deliveryTruth param — structured path primary, regex fallback kept.
 *   2. Future: remove regex fallback after all callers pass deliveryTruth.
 */
export function isCardInFlight(
  backlogStatus: string,
  prEvidence: AuditPrEvidence | undefined,
  deliveryTruth?: StoryDeliveryTruth,
): boolean {
  // US-TRUTH-017 (codex review): structured `done` is authoritative — it must
  // win over potentially-stale OPEN PR evidence, so a delivered card is never
  // kept in-flight by a lagging probe.
  if (deliveryTruth?.lifecycleState === "done") return false;
  if (prEvidence !== undefined) {
    const state = prEvidence.state.toUpperCase();
    if (state === "MERGED") return false; // a merge is delivery, not in-flight
    if (state === "OPEN") return true;
  }
  // US-TRUTH-017: prefer structured delivery truth for in-flight detection.
  if (deliveryTruth !== undefined) {
    // in_flight/ci_red is "handed to the PR lane" ONLY with a real PR number; a
    // lifecycle in those states but with no prNumber is a half-written/abnormal
    // state, not in-flight (codex review — don't skip the picker on it).
    if (deliveryTruth.lifecycleState === "pending_merge" || deliveryTruth.lifecycleState === "ci_red") {
      return deliveryTruth.prNumber !== undefined;
    }
    return false; // todo / failed / other → not in-flight
  }
  // Deprecated fallback (AC3): regex parse of backlog status string.
  // Kept for legacy rows that predate the structured delivery store.
  return /PR#\d+/.test(backlogStatus);
}

/**
 * FIX-337 (AC5) — the goal evaluation. `delivered` now counts MERGED cards AND
 * open-PR IN-FLIGHT cards (the cycle-ledger `delivered + pending_merge` figure),
 * so the loop's progress reading credits a card whose PR is open and handed to
 * the PR lane — it is no longer falsely shown as "0 delivered" while real work is
 * mid-merge. `completion` is UNCHANGED: it still requires EVERY scoped card to be
 * really merged (blockers are merge-gated on `truth.delivered`), so an in-flight
 * card keeps the goal open until its merge lands. The display number and the
 * completion gate are deliberately distinct (in-flight ≠ done).
 */
export function goalEvaluationFromTruth(
  truths: StoryTruth[],
  scope: GoalScope,
  opts: { allowEmptyAllComplete: boolean; inFlightIds?: ReadonlySet<string> },
): GoalEvaluation {
  const total = truths.length;
  const inFlight = opts.inFlightIds ?? new Set<string>();
  // delivered-or-in-flight: merged cards plus open-PR cards not yet merged.
  const delivered = truths.filter((truth) => truth.delivered || (!truth.delivered && inFlight.has(truth.storyId))).length;
  // completion stays merge-gated: an in-flight (not-yet-merged) card is STILL a
  // blocker, so the goal does not complete until every PR actually merges.
  const blockers = truths
    .filter((truth) => !truth.delivered || truth.state === "fail" || truth.state === "unknown")
    .map((truth) => `${truth.storyId}:${truth.state}:${truth.reason}`);
  if ((total > 0 || (scope.kind === "all" && opts.allowEmptyAllComplete)) && blockers.length === 0) {
    return { complete: true, reason: "all_delivered", blockers: [], total, delivered };
  }
  const first = blockers[0];
  return {
    complete: false,
    reason: first === undefined ? "waiting:no_scope_cards" : `blocked:${first.replace(/:fail:/, ":").replace(/:unknown:/, ":")}`,
    blockers,
    total,
    delivered,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function workerAgentsFromRunRows(rows: readonly Record<string, unknown>[]): string[] {
  return uniqueStrings(rows.map((row) => (typeof row["agent"] === "string" ? row["agent"] : "")));
}

async function workerAgentsForSession(projectPath: string, session: string): Promise<string[]> {
  const out: string[] = [];
  let inSession = false;
  const path = eventsPath(projectPath);
  if (!existsSync(path)) return out;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = parseEventLine(line);
      if (event === null) continue;
      if (event.type === "goal:session_start") {
        if (event.sessionId === session) inSession = true;
        else if (inSession) break;
        continue;
      }
      if (!inSession) continue;
      if (event.type === "cycle:start" || event.type === "route:resolve") out.push(event.agent);
    }
  } catch {
    return [];
  } finally {
    lines.close();
  }
  return uniqueStrings(out);
}

export function spawnFinalReviewAgent(agent: string, cwd: string, prompt: string, timeoutMs: number): Promise<FinalReviewProcessResult> {
  return spawnPeerReviewAgent({ agent, projectPath: cwd, prompt, timeoutMs });
}

function finalReviewPrompt(input: GoalFinalReviewInput): string {
  return [
    "You are Roll's final goal review gate. Review only; do not edit files, create commits, push, or open PRs.",
    "The goal truth adjudicator says all scoped cards are delivered. Challenge that conclusion before completion is sealed.",
    "Check acceptance criteria, implementation, tests, and evidence for watered-down or convenient readings.",
    "Return exactly one VERDICT line with APPROVE or REQUEST_CHANGES. Add one REASON line and optional FINDING lines.",
    "",
    `Session: ${input.sessionId}`,
    `Requested review mode: ${input.mode}`,
    `Goal: ${JSON.stringify({ scope: input.goal.scope, usage: input.goal.usage, lastDecisionReason: input.goal.lastDecisionReason ?? "" })}`,
    `Truth evaluation: ${JSON.stringify(input.evaluation)}`,
    "",
    "Format:",
    "VERDICT: APPROVE|REQUEST_CHANGES",
    "REASON: <short reason>",
    "FINDING: <concrete issue>",
  ].join("\n");
}

type FinalReviewProcessResult =
  SpawnPeerReviewResult;

async function defaultFinalReview(input: GoalFinalReviewInput): Promise<GoalFinalReviewResult> {
  const facts = await runPeerReview({
    projectPath: input.projectPath,
    prompt: finalReviewPrompt(input),
    mode: input.mode,
    workerAgents: input.workerAgents.length > 0 ? input.workerAgents : [projectAgent()],
    timeoutMs: input.timeoutMs,
    purpose: "goal_final_review",
  });
  return {
    effectiveMode: facts.effectiveMode ?? (input.mode === "self" ? "self" : "hetero"),
    reviewer: facts.agent,
    provider: facts.provider,
    commandFamily: facts.commandFamily,
    verdict: facts.verdict,
    reason: facts.reason,
    findings: facts.findings,
    durationMs: facts.durationMs,
    ...(facts.transcriptPath !== undefined ? { transcriptPath: facts.transcriptPath } : {}),
    ...(facts.evidencePath !== undefined ? { evidencePath: facts.evidencePath } : {}),
    ...(facts.degradedReason !== undefined ? { degradedReason: facts.degradedReason } : {}),
  };
}

function backlogExists(projectPath: string): boolean {
  return existsSync(backlogPath(projectPath));
}

interface FinalReviewGateResult {
  passed: boolean;
  reason: string;
}

function reviewBlockReason(verdict: GoalFinalReviewResult["verdict"], reason: string): string {
  return `final_review:${verdict.toLowerCase()}:${reason}`;
}

function safeNotePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "review";
}

function finalReviewNoteBody(session: string, review: GoalFinalReviewResult, at: string): string {
  const findings = review.findings.length > 0 ? review.findings.map((finding) => `- ${finding}`).join("\n") : "- No detailed findings provided.";
  return [
    "---",
    "source: goal_final_review",
    `session: ${session}`,
    `verdict: ${review.verdict}`,
    `reviewer: ${review.reviewer}`,
    `provider: ${review.provider}`,
    `created: ${at}`,
    "---",
    "",
    `# Goal final review: ${review.verdict}`,
    "",
    `Reason: ${review.reason}`,
    "",
    "Findings:",
    findings,
    "",
  ].join("\n");
}

function writeFinalReviewNotes(projectPath: string, goal: RollGoal, session: string, review: GoalFinalReviewResult, at: string): void {
  if (review.verdict === "APPROVE") return;
  const fileName = `final-review-${safeNotePart(session)}.md`;
  const body = finalReviewNoteBody(session, review, at);
  for (const row of rowsForScope(projectPath, goal.scope)) {
    const notesDir = join(cardArchiveDir(projectPath, row.id), "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, fileName), body, "utf8");
  }
}

async function runFinalReviewGate(
  projectPath: string,
  slug: string,
  goal: RollGoal,
  evaluation: GoalEvaluation,
  deps: LoopGoDeps,
  session: string,
  workerAgents: readonly string[],
  bus: EventBus,
): Promise<FinalReviewGateResult> {
  const mode = goal.review.mode;
  if (mode === "off") {
    bus.appendEvent(eventsPath(projectPath), {
      type: "goal:final_review",
      sessionId: session,
      mode,
      effectiveMode: "off",
      reviewer: "",
      provider: "",
      verdict: "SKIPPED",
      reason: "review_off",
      findings: [],
      ts: deps.nowSec(),
    });
    return { passed: true, reason: "final_review:skipped:review_off" };
  }

  // FIX-280 (AC3): the final review can throw on a TRANSIENT fault (a flaky peer
  // spawn, a momentary network blip). Don't collapse that into an opaque generic
  // ERROR with no reason — retry once, and if it still fails surface the REAL
  // error and raise an ALERT so the crash is observable, not swallowed.
  const inferredWorkers = workerAgents.length > 0 ? uniqueStrings(workerAgents) : await workerAgentsForSession(projectPath, session);
  const reviewInput: GoalFinalReviewInput = {
    projectPath,
    sessionId: session,
    mode,
    goal,
    evaluation,
    workerAgents: inferredWorkers,
    timeoutMs: FINAL_REVIEW_TIMEOUT_MS,
  };
  const runReview = deps.finalReview ?? defaultFinalReview;
  let review: GoalFinalReviewResult;
  try {
    review = await runReview(reviewInput);
  } catch (firstError) {
    const firstReason = firstError instanceof Error ? firstError.message : "final_review_error";
    try {
      review = await runReview(reviewInput);
    } catch (retryError) {
      const reason = `final_review_error_after_retry: ${retryError instanceof Error ? retryError.message : firstReason}`;
      review = {
        effectiveMode: mode === "self" ? "self" : "hetero",
        reviewer: "",
        provider: "",
        verdict: "ERROR",
        reason,
        findings: [],
      };
      appendReviewAlert(projectPath, slug, session, reason, deps.nowIso());
    }
  }

  if (mode === "auto" && review.degradedReason !== undefined) {
    bus.appendEvent(eventsPath(projectPath), {
      type: "goal:review_degraded",
      sessionId: session,
      from: "auto",
      to: "self",
      reviewer: review.reviewer,
      provider: review.provider,
      reason: review.degradedReason,
      ts: deps.nowSec(),
    });
  }
  bus.appendEvent(eventsPath(projectPath), {
    type: "goal:final_review",
    sessionId: session,
    mode,
    effectiveMode: review.effectiveMode,
    reviewer: review.reviewer,
    provider: review.provider,
    verdict: review.verdict,
    reason: review.reason,
    findings: review.findings,
    ...(review.commandFamily !== undefined ? { commandFamily: review.commandFamily } : {}),
    ...(review.durationMs !== undefined ? { durationMs: review.durationMs } : {}),
    ...(review.transcriptPath !== undefined ? { transcriptPath: review.transcriptPath } : {}),
    ...(review.evidencePath !== undefined ? { evidencePath: review.evidencePath } : {}),
    ts: deps.nowSec(),
  });
  writeFinalReviewNotes(projectPath, goal, session, review, deps.nowIso());
  return {
    passed: review.verdict === "APPROVE",
    reason: reviewBlockReason(review.verdict, review.reason),
  };
}

async function evaluateGoal(
  projectPath: string,
  slug: string,
  goal: RollGoal,
  deps: LoopGoDeps,
  session: string,
  workerAgents: readonly string[],
  bus: EventBus,
): Promise<{ goal: RollGoal; complete: boolean; reason: string; reviewBlocked: boolean }> {
  const rows = rowsForScope(projectPath, goal.scope);
  const truths: StoryTruth[] = [];
  // FIX-337 (AC5): track which scoped cards are IN-FLIGHT (PR open, not merged),
  // so the `delivered` reading credits them like the cycle-ledger pending_merge
  // figure. Completion stays merge-gated (these remain blockers).
  const inFlightIds = new Set<string>();
  // FIX-388 / FIX-906: batch-read delivery truth once, reuse per story (AC5).
  // `ensureDeliveriesFresh` (not the raw `readDeliveries`) rebuilds the cache
  // from runs + git merges on origin/main when stale (FIX-904/905), so goal
  // evaluation sees EXTERNAL / manual merges — the same unified truth the
  // picker/preflight and `roll truth query` read. Best-effort: a git/IO failure
  // inside ensureDeliveriesFresh leaves the existing cache, never topples eval.
  const deliveries = ensureDeliveriesFresh(projectPath, nodeFreshnessPort, nodeExecPort, resolveIntegrationBranch(projectPath));
  for (const row of rows) {
    // AC4: only pass deliveryTruth when the card has real delivery records;
    // cards with no records fall back to markdown parsing (backward compat).
    const rawTruth = queryStoryDelivery(row.id, deliveries);
    const deliveryTruth = rawTruth.lastRecordedAt > 0 ? rawTruth : undefined;
    const prEvidence = deps.prEvidence !== undefined ? await deps.prEvidence(projectPath, row.id, row.status) : undefined;
    if (isCardInFlight(row.status, prEvidence, deliveryTruth)) inFlightIds.add(row.id);
    truths.push(storyTruthFromBacklog(row.id, row.status, { ...(prEvidence !== undefined ? { prEvidence } : {}), nowSec: deps.nowSec(), deliveryTruth }));
  }
  const verdict = goalEvaluationFromTruth(truths, goal.scope, { allowEmptyAllComplete: backlogExists(projectPath), inFlightIds });
  // FIX-1022: when an --epic scope matches no cards, list the available epic
  // names so the user knows what value to pass next time.
  let verdictReason = verdict.reason;
  if (verdictReason === "waiting:no_scope_cards" && goal.scope.kind === "epic") {
    const availableEpics = [...new Set(Object.values(readStoryIndex(projectPath)))].sort();
    if (availableEpics.length > 0) {
      verdictReason = `${verdictReason} (available epics: ${availableEpics.join(", ")})`;
    }
  }
  bus.appendEvent(eventsPath(projectPath), {
    type: "goal:evaluated",
    sessionId: session,
    status: verdict.complete ? "complete" : "continue",
    total: verdict.total,
    delivered: verdict.delivered,
    reason: verdictReason,
    blockers: verdict.blockers,
    ts: deps.nowSec(),
  });
  const at = deps.nowIso();
  if (verdict.complete) {
    const review = await runFinalReviewGate(projectPath, slug, goal, verdict, deps, session, workerAgents, bus);
    if (!review.passed) {
      const next = { ...goal, updatedAt: at, lastDecisionReason: review.reason };
      writeGoal(goalPath(projectPath), next);
      return { goal: next, complete: false, reason: review.reason, reviewBlocked: true };
    }
    const reason = `${verdict.reason}; ${review.reason}`;
    const next = transitionGoal(goal, "complete", { actor: "adjudicator", reason, at });
    writeGoal(goalPath(projectPath), next);
    appendGoalState(bus, eventsPath(projectPath), goal.status, next, "adjudicator", reason, deps.nowSec());
    return { goal: next, complete: true, reason, reviewBlocked: false };
  }
  const next = { ...goal, updatedAt: at, lastDecisionReason: verdictReason };
  writeGoal(goalPath(projectPath), next);
  return { goal: next, complete: false, reason: verdictReason, reviewBlocked: false };
}

/** Normalize an event ts to whole seconds (ms epoch ≥ 1e12 → s). */
function eventTsSeconds(ts: number): number {
  return ts >= 1e12 ? Math.floor(ts / 1000) : ts;
}

export function hasSafetyPauseSince(path: string, since: number): boolean {
  // FIX-1255: safety_pause writers are split between second (correction
  // circuit) and millisecond (run-once auth blocks) epochs. `since` is
  // seconds; compare in seconds or every historical ms-stamped pause event
  // reads as "in the future" and stops the session after its first cycle.
  const sinceSec = eventTsSeconds(since);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row["type"] === "policy:safety_pause" && typeof row["ts"] === "number" && eventTsSeconds(row["ts"]) >= sinceSec) return true;
  }
  return false;
}

function sessionId(at: string, pid: number): string {
  const compact = at.replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `goal-${compact}-${pid}`;
}

function appendGoalState(bus: EventBus, path: string, from: GoalStatus, goal: RollGoal, actor: "owner" | "system" | "adjudicator", reason: string, ts: number): void {
  bus.appendEvent(path, {
    type: "goal:state",
    schema: GOAL_SCHEMA_VERSION,
    from,
    to: goal.status,
    actor,
    reason,
    ts,
  });
}

function withSafety(goal: RollGoal, gate: GoalSafetyGate, reason: string, reading: string, at: string): RollGoal {
  return {
    ...goal,
    safety: {
      lastGate: gate,
      lastReason: reason,
      lastAt: at,
      lastReading: reading,
    },
  };
}

function appendGoalGate(
  bus: EventBus,
  path: string,
  session: string,
  gate: GoalSafetyGate,
  action: "audit" | "paused",
  reason: string,
  reading: Record<string, string | number | boolean>,
  ts: number,
  waitUntilSec?: number,
): void {
  bus.appendEvent(path, {
    type: "goal:gate_tripped",
    sessionId: session,
    gate,
    action,
    reason,
    reading,
    ...(waitUntilSec !== undefined ? { waitUntilSec } : {}),
    ts,
  });
}

function pauseGoal(projectPath: string, bus: EventBus, reason: string, at: string, ts: number): RollGoal | undefined {
  const path = goalPath(projectPath);
  const goal = readGoal(path);
  if (goal === undefined) return undefined;
  if (goal.status === "paused" || goal.status === "complete") return goal;
  const next = transitionGoal(goal, "paused", { actor: "system", reason, at });
  writeGoal(path, next);
  appendGoalState(bus, eventsPath(projectPath), goal.status, next, "system", reason, ts);
  return next;
}

function updateUsage(projectPath: string, goal: RollGoal, baseline: RunSummary, initial: RunSummary, at: string): RollGoal {
  const current = summarizeRuns(runsPath(projectPath));
  return {
    ...goal,
    usage: {
      cycles: initial.cycles + Math.max(0, current.cycles - baseline.cycles),
      costUsd: initial.costUsd + Math.max(0, current.costUsd - baseline.costUsd),
    },
    updatedAt: at,
  };
}

function runSummaryFromGoal(goal: RollGoal): RunSummary {
  return {
    cycles: goal.usage.cycles,
    costUsd: goal.usage.costUsd,
  };
}

/** Are two goal scopes the same identity? (FIX-333 — scope-change detection.) */
function scopesEqual(a: GoalScope, b: GoalScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "epic" && b.kind === "epic") return a.epic === b.epic;
  if (a.kind === "cards" && b.kind === "cards") {
    if (a.cards.length !== b.cards.length) return false;
    const bSet = new Set(b.cards);
    return a.cards.every((card) => bSet.has(card));
  }
  return true; // both "all"
}

function applyRunOptions(goal: RollGoal, opts: GoOptions, at: string): RollGoal {
  // FIX-279: run limits are EXPLICIT per `roll loop go` — they come only from
  // THIS invocation's flags, never silently inherited from a prior session's
  // persisted goal. Omitting --max-cycles / --for means "no limit this run" (the
  // same defaults a fresh goal gets), so a flagless go can't be capped by a
  // limit set days ago. (Scope and review still persist when unspecified — those
  // are the goal's identity, not a per-run safety knob.) Strip the persisted
  // limits, then re-apply only what was passed now.
  const nextScope = opts.scopeSpecified ? opts.scope : goal.scope;
  // FIX-333: when this invocation CHANGES the scope (--cards/--epic differs from
  // the persisted goal), the carried-over progress counters (noProgressCycles /
  // zeroStreaks / skippedCards) belong to the OLD scope. Inheriting them would
  // let a fresh scope inherit the previous scope's stalled count and trip the
  // no_progress_breaker the instant it starts. Drop the whole progress block so
  // the new scope begins with clean accounting.
  const scopeChanged = !scopesEqual(goal.scope, nextScope);
  const { limits: _staleLimits, progress: _staleProgress, ...rest } = goal;
  return {
    ...rest,
    ...(scopeChanged ? {} : goal.progress !== undefined ? { progress: goal.progress } : {}),
    scope: nextScope,
    review: opts.reviewModeSpecified ? { mode: opts.reviewMode } : goal.review,
    limits: {
      ...(opts.maxCycles !== undefined ? { maxCycles: opts.maxCycles } : {}),
      ...(opts.forSeconds !== undefined ? { maxHours: opts.forSeconds / 3600 } : {}),
    },
    updatedAt: at,
  };
}

function latestAlertSummary(projectPath: string, slug: string, sinceSec: number): string | undefined {
  const path = alertPath(projectPath, slug);
  try {
    if (!existsSync(path) || statSync(path).mtimeMs / 1000 < sinceSec) return undefined;
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const line = [...lines].reverse().find((candidate) => /\b(ALERT|WARN|BLOCKED|refused|failed)\b/i.test(candidate));
    if (line === undefined) return undefined;
    return line.replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return undefined;
  }
}

function noCycleTerminalReason(projectPath: string, slug: string, sinceSec: number): string {
  const alert = latestAlertSummary(projectPath, slug, sinceSec);
  return alert === undefined ? "no_cycle_terminal" : `no_cycle_terminal: ${alert}`;
}

/** Live owner pid of the runner's inner lock, or undefined when free/stale. */
function innerLockHolder(projectPath: string, nowSec: number): number | undefined {
  const path = join(runtimeDir(projectPath), "inner.lock");
  try {
    if (!existsSync(path)) return undefined;
    const owner = readLockOwner(path);
    return isOwnerHeld(owner, nowSec, INNER_LOCK_STALE_SEC) ? owner?.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Block until the inner lock is free (a scheduled cycle may be mid-flight),
 * polling every {@link INNER_LOCK_WAIT_MS} up to {@link INNER_LOCK_WAIT_MAX_MS}.
 * Emits one `goal:waiting_inner_lock` event when the wait begins so the
 * session is observable while parked. Returns early on a stop signal.
 */
async function waitForInnerLock(
  projectPath: string,
  session: string,
  deps: LoopGoDeps,
  bus: EventBus,
  evPath: string,
  stopped: () => boolean,
): Promise<"free" | "timeout"> {
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  let holder = innerLockHolder(projectPath, deps.nowSec());
  if (holder === undefined) return "free";
  bus.appendEvent(evPath, {
    type: "goal:waiting_inner_lock",
    sessionId: session,
    heldByPid: holder,
    ts: deps.nowSec(),
  });
  let waitedMs = 0;
  while (holder !== undefined) {
    if (waitedMs >= INNER_LOCK_WAIT_MAX_MS) return "timeout";
    await sleep(INNER_LOCK_WAIT_MS);
    waitedMs += INNER_LOCK_WAIT_MS;
    if (stopped()) return "free";
    holder = innerLockHolder(projectPath, deps.nowSec());
  }
  return "free";
}

/**
 * Hook 2 — the cross-session dead-loop breaker, in the gate slot the removed
 * budget gate vacated. When the whole-goal no-progress streak reaches
 * {@link GOAL_NO_PROGRESS_STOP}, STOP the goal (pause) with a distinct loud
 * ALERT + remediation hint and a `progress` gate event. This is the
 * deterministic global backstop that replaces the dollar ceiling: an unmergeable
 * card can never spin past K cycles. The counter persists on the goal so the K
 * cap holds ACROSS sessions, not just within one.
 */
function applyProgressGate(
  projectPath: string,
  bus: EventBus,
  session: string,
  slug: string,
  goal: RollGoal,
  progress: ProgressState,
  deps: LoopGoDeps,
): { goal: RollGoal; stopped: boolean; reason?: string } {
  if (progress.noProgressCycles < GOAL_NO_PROGRESS_STOP) return { goal, stopped: false };
  const reason = "no_progress_breaker";
  const at = deps.nowIso();
  const ts = deps.nowSec();
  const reading = { noProgressCycles: progress.noProgressCycles, threshold: GOAL_NO_PROGRESS_STOP };
  const labelled = withSafety(goal, "progress", reason, `${progress.noProgressCycles} consecutive no-progress cycles >= ${GOAL_NO_PROGRESS_STOP}`, at);
  const paused = transitionGoal(labelled, "paused", { actor: "system", reason, at });
  writeGoal(goalPath(projectPath), paused);
  appendGoalState(bus, eventsPath(projectPath), goal.status, paused, "system", reason, ts);
  appendGoalGate(bus, eventsPath(projectPath), session, "progress", "paused", reason, reading, ts);
  appendBreakerAlert(projectPath, slug, progress.noProgressCycles, at);
  return { goal: paused, stopped: true, reason };
}

function timeboxDeadlineSec(goal: RollGoal, opts: GoOptions, startedSec: number): number | undefined {
  const seconds = opts.forSeconds ?? (goal.limits.maxHours !== undefined ? goal.limits.maxHours * 3600 : undefined);
  return seconds === undefined ? undefined : startedSec + seconds;
}

function applyTimeboxGate(
  projectPath: string,
  bus: EventBus,
  session: string,
  goal: RollGoal,
  deps: LoopGoDeps,
  deadlineSec: number | undefined,
): { goal: RollGoal; stopped: boolean; reason?: string } {
  if (deadlineSec === undefined || deps.nowSec() < deadlineSec) return { goal, stopped: false };
  const reason = "timebox";
  const at = deps.nowIso();
  const ts = deps.nowSec();
  const reading = { nowSec: ts, deadlineSec };
  const labelled = withSafety(goal, "timebox", reason, `now ${ts} >= deadline ${deadlineSec}`, at);
  const paused = transitionGoal(labelled, "paused", { actor: "system", reason, at });
  writeGoal(goalPath(projectPath), paused);
  appendGoalState(bus, eventsPath(projectPath), goal.status, paused, "system", reason, ts);
  appendGoalGate(bus, eventsPath(projectPath), session, "timebox", "paused", reason, reading, ts);
  return { goal: paused, stopped: true, reason };
}

function installStopHandlers(onStop: (signal: string) => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => {
    const handler = (): void => onStop(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}

/** Human-readable scope line for startup feedback. */
function describeScope(scope: GoalScope): string {
  if (scope.kind === "cards") return `cards ${scope.cards.join(", ")}`;
  if (scope.kind === "epic") return `epic ${scope.epic}`;
  return "all Todo backlog cards";
}

/** The scope a `go` invocation will actually run, plus whether it was
 * inherited from a live persisted goal rather than set by this run's flags. */
interface EffectiveScope {
  scope: GoalScope;
  inherited: boolean;
}

/**
 * FIX-1253: resolve the scope the worker will actually persist, mirroring the
 * goal resolution in {@link runGoWorker}. A flagless `go` inherits a LIVE goal's
 * persisted scope (scope is the goal's identity — FIX-279), so the startup
 * banner must show THAT, not the parsed default of "all". Without this the
 * banner printed `all Todo backlog cards` while the loop silently ran a stale
 * `cards:[…]` goal — the owner thought a full sweep was running when nothing
 * new was touched. A fresh or completed(-then-archived) goal starts from
 * opts.scope, so only a non-terminal goal's scope carries over.
 */
function resolveEffectiveScope(projectPath: string, opts: GoOptions): EffectiveScope {
  if (opts.scopeSpecified) return { scope: opts.scope, inherited: false };
  const existing = readGoal(goalPath(projectPath));
  if (existing === undefined || existing.status === "complete") {
    return { scope: opts.scope, inherited: false };
  }
  // Carried over from the live goal. Flag it (so the owner sees a narrowing)
  // only when the inherited scope is not already the full backlog — inheriting
  // "all" is the unsurprising default and needs no callout.
  return { scope: existing.scope, inherited: existing.scope.kind !== "all" };
}

/**
 * FIX-289 (AC1): a clear, multi-line startup confirmation — the session name,
 * the scope, that the first cycle is now running, and the read-only way to
 * observe it. Replaces the vague one-liner that left no clue what was happening.
 *
 * FIX-1253: `scope` is the EFFECTIVE scope (see {@link resolveEffectiveScope}).
 * When it was inherited from an existing goal the line is annotated with the
 * source and the way to change it, so a flagless go can never silently narrow.
 */
function goStartupFeedback(slug: string, effective: EffectiveScope): string {
  const session = goSessionName(slug);
  const { scope, inherited } = effective;
  const scopeEn = inherited
    ? `${describeScope(scope)} (inherited from existing goal; pass --cards/--epic/--all to change)`
    : describeScope(scope);
  const scopeZh = inherited
    ? `${describeScope(scope)} (沿用现有 goal；用 --cards/--epic/--all 更改)`
    : describeScope(scope);
  return [
    `Goal go session started: ${session}`,
    `  scope:   ${scopeEn}`,
    "  cycles:  first cycle is running now; cycles chain until the scope is complete, paused, or capped.",
    `  observe: tmux attach -t ${session}  (read-only watch window; the 'go' window is the worker — do not Ctrl-C it)`,
    `           or follow inline:  roll loop go --attach`,
    "",
    `goal 连跑会话已启动: ${session}`,
    `  scope:   ${scopeZh}`,
    "  第一个 cycle 正在运行；会持续连跑直到范围完成、暂停或达上限。",
    `  观察 (只读): tmux attach -t ${session}  或  roll loop go --attach`,
    "",
  ].join("\n");
}

export async function loopGoCommand(args: string[], deps: LoopGoDeps = realDeps()): Promise<number> {
  if (hasHelpArg(args)) {
    process.stdout.write(loopGoHelp());
    return 0;
  }
  const opts = parseOptions(args);
  let id: ProjectId;
  let workspace: { workspaceId: string; runtimeRoot: string; backlogPath: string } | undefined;
  if (deps.resolveTarget !== undefined) {
    const selectorArgs: string[] = [];
    const workspaceIndex = canonicalWorkspaceSelectorIndex(args);
    if (workspaceIndex >= 0) selectorArgs.push(...workspaceSelectorArgs(args[workspaceIndex + 1] ?? ""));
    const decision = deps.resolveTarget(selectorArgs, "mutation");
    if (!decision.ok) return emitBacklogTargetError(decision);
    if ("aggregate" in decision) return emitBacklogTargetError({ ok: false, code: "invalid_target", candidates: [] });
    id = { path: decision.workspaceRoot, slug: decision.workspaceId };
    workspace = {
      workspaceId: decision.workspaceId,
      runtimeRoot: decision.runtimeRoot,
      backlogPath: decision.backlogPath,
    };
  } else {
    id = await deps.identity();
  }

  const savedWorkspace = process.env["ROLL_WORKSPACE"];
  const savedRuntime = process.env["ROLL_PROJECT_RUNTIME_DIR"];
  const savedBacklog = process.env["ROLL_WORKSPACE_BACKLOG_PATH"];
  if (workspace !== undefined) {
    process.env["ROLL_WORKSPACE"] = workspace.workspaceId;
    process.env["ROLL_PROJECT_RUNTIME_DIR"] = workspace.runtimeRoot;
    process.env["ROLL_WORKSPACE_BACKLOG_PATH"] = workspace.backlogPath;
  }
  try {
    if (!opts.worker && !opts.noTmux && deps.hasTmux()) {
      const started = deps.startTmux({
        projectPath: id.path,
        slug: id.slug,
        args,
        rollBin: rollBin(),
        ...(workspace === undefined ? {} : workspace),
      });
      if (started) {
        process.stdout.write(goStartupFeedback(id.slug, resolveEffectiveScope(id.path, opts)));
        // FIX-289 (AC3): --attach follows the read-only live feed in the
        // foreground. Ctrl-C there only stops this view; the cycle keeps running
        // in its detached tmux window.
        if (opts.attach && deps.followFeed !== undefined) {
          process.stdout.write(
            "Following live feed (Ctrl-C stops the view, not the loop) …\n" +
              "正在跟随实时输出 (Ctrl-C 只停止查看，不会停止 loop) …\n",
          );
          await deps.followFeed(id.path, rollBin());
        }
        return 0;
      }
    }
    return await runGoWorker(id, opts, deps);
  } finally {
    if (savedWorkspace === undefined) delete process.env["ROLL_WORKSPACE"];
    else process.env["ROLL_WORKSPACE"] = savedWorkspace;
    if (savedRuntime === undefined) delete process.env["ROLL_PROJECT_RUNTIME_DIR"];
    else process.env["ROLL_PROJECT_RUNTIME_DIR"] = savedRuntime;
    if (savedBacklog === undefined) delete process.env["ROLL_WORKSPACE_BACKLOG_PATH"];
    else process.env["ROLL_WORKSPACE_BACKLOG_PATH"] = savedBacklog;
  }
}

async function runGoWorker(id: ProjectId, opts: GoOptions, deps: LoopGoDeps): Promise<number> {
  const rt = runtimeDir(id.path);
  mkdirSync(rt, { recursive: true });
  const runner = loopControlRunnerReadout(id.path);
  process.stdout.write(`roll loop go: runner ${runner.bin} v${runner.runningVersion}\n`);
  if (runner.projectNewer) {
    process.stderr.write(staleLoopRunnerMessage("roll loop go", runner));
    return 1;
  }
  const bus = new EventBus();
  const evPath = eventsPath(id.path);
  const lockPath = goLockPath(id.path);
  const acq = acquireLock(lockPath, deps.pid(), { staleSec: GO_LOCK_STALE_SEC, now: deps.nowSec });
  if (!acq.acquired) {
    bus.appendEvent(evPath, {
      type: "goal:tick_skipped",
      reason: "go_session_lock",
      ...(acq.heldByPid !== undefined ? { heldByPid: acq.heldByPid } : {}),
      ts: deps.nowSec(),
    });
    process.stdout.write(`roll loop go: go session already active (pid ${acq.heldByPid ?? "?"}); skipped\n`);
    return 0;
  }

  const startedAt = deps.nowIso();
  const startedSec = deps.nowSec();
  deps.externalTools?.("go");
  // FIX-394 AC2: best-effort Chromium pre-install before the first cycle
  // so web screenshot evidence doesn't stall on a 100-200 MB download.
  // Routed through deps so tests can stub it (a real install is a 5-min
  // subprocess that would otherwise hang the suite when Chromium is absent).
  deps.preinstallChromium?.();
  const sid = sessionId(startedAt, deps.pid());
  const baseline = summarizeRuns(runsPath(id.path));
  let initialUsage: RunSummary = { cycles: 0, costUsd: 0 };
  let goal: RollGoal;
  // Hook 2: hydrate the no-progress accounting from the persisted goal once it
  // is loaded (below) so the dead-loop breaker counts ACROSS sessions.
  let progress: ProgressState = { zeroStreaks: new Map(), skippedCards: new Set(), noProgressCycles: 0, deliveredCards: new Set() };
  let stopReason: string | undefined;
  let stopRequested = false;
  let workerAgents: string[] = [];
  const disposeSignals = installStopHandlers((signal) => {
    stopRequested = true;
    stopReason = `signal_${signal}`;
  });

  try {
    const gPath = goalPath(id.path);
    const existing = readGoal(gPath);
    if (existing === undefined) {
      goal = createGoal(opts, startedAt);
      writeGoal(gPath, goal);
      bus.appendEvent(evPath, {
        type: "goal:created",
        schema: GOAL_SCHEMA_VERSION,
        scope: goal.scope,
        status: "active",
        review: goal.review.mode,
        ts: startedSec,
      });
    } else if (existing.status === "complete") {
      const archivePath = archiveCompletedGoal(gPath, existing);
      bus.appendEvent(evPath, {
        type: "goal:archived",
        schema: GOAL_SCHEMA_VERSION,
        scope: existing.scope,
        status: "complete",
        archivePath,
        ts: startedSec,
      });
      goal = createGoal(opts, startedAt);
      writeGoal(gPath, goal);
      bus.appendEvent(evPath, {
        type: "goal:created",
        schema: GOAL_SCHEMA_VERSION,
        scope: goal.scope,
        status: "active",
        review: goal.review.mode,
        ts: startedSec,
      });
    } else if (existing.status === "active") {
      goal = existing;
    } else {
      goal = transitionGoal(existing, "active", { actor: "owner", reason: "go_start", at: startedAt });
      writeGoal(gPath, goal);
      appendGoalState(bus, evPath, existing.status, goal, "owner", "go_start", startedSec);
    }
    goal = applyRunOptions(goal, opts, startedAt);
    writeGoal(gPath, goal);
    // FIX-1253: on a direct (non-tmux) run there is no parent to print the
    // startup banner, so emit it here from the RESOLVED goal — the true
    // effective scope, flagged when inherited. (--worker runs inside the tmux
    // window whose parent already printed the banner, so skip it there.)
    if (!opts.worker) {
      const inherited =
        !opts.scopeSpecified && existing !== undefined && existing.status !== "complete" && goal.scope.kind !== "all";
      process.stdout.write(goStartupFeedback(id.slug, { scope: goal.scope, inherited }));
    }
    // Hook 2: resume the persisted no-progress accounting so an unmergeable card
    // that idled in a PRIOR session keeps accumulating toward the breaker.
    progress = progressFromGoal(goal);
    initialUsage = runSummaryFromGoal(goal);
    const deadlineSec = timeboxDeadlineSec(goal, opts, startedSec);
    // FIX-1472: a guided/supervisor one-shot (explicit `--cards` named this run)
    // runs the scoped card even while autonomous scheduling is paused. Computed
    // from THIS run's options, not the persisted goal, so an inherited cards
    // scope never silently bypasses the pause.
    const guided = isGuidedRun(opts);
    bus.appendEvent(evPath, { type: "goal:session_start", sessionId: sid, scope: goal.scope, ts: startedSec });

    while (true) {
      if (stopRequested) break;
      if (!guided && existsSync(pauseMarkerPath(id.path, id.slug))) {
        stopReason = "pause_marker";
        break;
      }
      const maxCycles = goal.limits.maxCycles;
      if (maxCycles !== undefined && goal.usage.cycles - initialUsage.cycles >= maxCycles) {
        stopReason = "max_cycles";
        break;
      }
      // Hook 2: cross-session breaker — if a PRIOR session already accumulated
      // K no-progress cycles (a resumed dead loop), STOP before burning another.
      const preProgressGate = applyProgressGate(id.path, bus, sid, id.slug, goal, progress, deps);
      goal = preProgressGate.goal;
      if (preProgressGate.stopped) {
        stopReason = preProgressGate.reason;
        break;
      }

      // FIX-1272: classify the COMPLETE dirty-path set against the runner's
      // pending-delivery evidence manifests. Verified runner-owned artifacts
      // (a still-open PR's dossier/report/screenshots) never pause an unrelated
      // eligible card; only unknown/unverified pollution does.
      const bootstrap = classifyBootstrapArtifacts(
        gitDirtyPaths(id.path),
        readPendingDeliveryEvidenceManifests(id.path),
        id.path,
      );
      if (bootstrap.verified.length > 0) {
        appendGoalGate(
          bus,
          evPath,
          sid,
          "progress",
          "audit",
          "bootstrap_artifacts_verified",
          {
            verified: bootstrap.verified.join(", "),
            verifiedCount: bootstrap.verified.length,
            unconfirmedCount: bootstrap.unconfirmed.length,
            externalCount: bootstrap.external.length,
          },
          deps.nowSec(),
        );
      }
      if (bootstrap.kind === "bootstrap_only") {
        stopReason = "bootstrap_artifacts_unconfirmed";
        const reasonLine = `ALERT reason: bootstrap_artifacts_unconfirmed (${bootstrap.files.length} unconfirmed bootstrap artifact${bootstrap.files.length === 1 ? "" : "s"})`;
        appendGoalGate(
          bus,
          evPath,
          sid,
          "progress",
          "paused",
          stopReason,
          {
            reasonLine,
            files: bootstrap.files.join(", "),
            count: bootstrap.files.length,
            unconfirmed: bootstrap.unconfirmed.join(", "),
            external: bootstrap.external.join(", "),
            verifiedCount: bootstrap.verified.length,
          },
          deps.nowSec(),
        );
        process.stdout.write(bootstrapArtifactsMessage(bootstrap.files, bootstrap.verified));
        goal = pauseGoal(id.path, bus, stopReason, deps.nowIso(), deps.nowSec()) ?? goal;
        break;
      }

      const allowedCards = allowedCardsForScope(id.path, goal, progress);
      if (allScopeCardsSkipped(id.path, goal, progress)) {
        stopReason = "no_progress_on_all_cards";
        goal = pauseGoal(id.path, bus, stopReason, deps.nowIso(), deps.nowSec()) ?? goal;
        break;
      }
      // FIX-333: every scope card is settled for this session (each is either
      // skipped or already delivered in-flight). Nothing left to pick — end
      // CLEANLY and let the PR lane merge the open PRs. Without this guard the
      // session would call run-once with an empty allow-list and either spin
      // (idle/no-cycle-terminal) or re-pick the just-delivered card → double PR.
      if (allScopeCardsSettled(id.path, goal, progress)) {
        stopReason = "scope_in_flight";
        break;
      }
      // FIX-269: a scheduled cycle may already hold the inner lock when the
      // goal session starts — run-once would skip without producing a cycle
      // terminal, and the session would pause (`no_cycle_terminal`, cycles=0)
      // one second after `roll loop go` (observed live 2026-06-12 09:40).
      // Contention is not failure: wait for the running cycle to finish.
      const lockWait = await waitForInnerLock(id.path, sid, deps, bus, evPath, () => stopRequested);
      if (lockWait === "timeout") {
        stopReason = "inner_lock_busy";
        break;
      }
      if (stopRequested) break;
      if (!guided && existsSync(pauseMarkerPath(id.path, id.slug))) continue;
      const before = readRunSnapshot(runsPath(id.path));
      await deps.runOnce({ projectPath: id.path, allowedCards, ...(guided ? { guided: true } : {}) });
      goal = updateUsage(id.path, goal, baseline, initialUsage, deps.nowIso());
      writeGoal(gPath, goal);
      const after = readRunSnapshot(runsPath(id.path));
      const appendedRows = after.rows.slice(before.rows.length);
      const mismatchedStories = outOfScopeStoryIds(appendedRows, allowedCards);
      if (mismatchedStories.length > 0) {
        stopReason = `scope_mismatch:${mismatchedStories.join(",")} not in ${allowedCards.join(",")}`;
        appendGoalGate(
          bus,
          evPath,
          sid,
          "progress",
          "paused",
          "scope_mismatch",
          { expected: allowedCards.join(","), actual: mismatchedStories.join(",") },
          deps.nowSec(),
        );
        appendScopeMismatchAlert(id.path, id.slug, allowedCards, mismatchedStories, deps.nowIso());
        break;
      }
      workerAgents = uniqueStrings([...workerAgents, ...workerAgentsFromRunRows(appendedRows)]);
      updateProgressFromRows(id.path, id.slug, sid, appendedRows, progress, deps, bus);
      // Hook 2: persist the no-progress accounting onto the goal so the breaker
      // count survives this session ending (resume-safe global backstop).
      goal = goalWithProgress(goal, progress);
      writeGoal(gPath, goal);
      if (appendedRows.some((row) => row["status"] === "waiting_capacity" || row["outcome"] === "waiting_capacity")) {
        stopReason = "waiting_capacity";
        break;
      }
      // Hook 2 (post-cycle): the dead-loop breaker now occupies the slot the
      // budget gate vacated. K consecutive whole-goal no-progress cycles STOP.
      const progressGate = applyProgressGate(id.path, bus, sid, id.slug, goal, progress, deps);
      goal = progressGate.goal;
      if (progressGate.stopped) {
        stopReason = progressGate.reason;
        break;
      }
      if (allScopeCardsSkipped(id.path, goal, progress)) {
        stopReason = "no_progress_on_all_cards";
        goal = pauseGoal(id.path, bus, stopReason, deps.nowIso(), deps.nowSec()) ?? goal;
        break;
      }
      const adjudication = await evaluateGoal(id.path, id.slug, goal, deps, sid, workerAgents, bus);
      goal = adjudication.goal;
      if (adjudication.complete) {
        stopReason = "goal_complete";
        break;
      }
      if (adjudication.reviewBlocked) {
        stopReason = adjudication.reason;
        break;
      }
      // FIX-1034: check --max-cycles after evaluateGoal (so goal:evaluated
      // fires) but before allScopeCardsSettled (so the explicit session cap
      // takes priority over scope_in_flight when a card was delivered but the
      // owner explicitly asked to stop after N cycles).
      const maxCyclesAfter = goal.limits.maxCycles;
      if (maxCyclesAfter !== undefined && goal.usage.cycles - initialUsage.cycles >= maxCyclesAfter) {
        stopReason = "max_cycles";
        break;
      }
      // FIX-333: the truth adjudicator did not complete (the just-delivered
      // card's `✅ Done` lives on the cycle branch, not yet on main), but every
      // scope card is now settled for this session (delivered in-flight and/or
      // skipped). End CLEANLY rather than loop back and re-pick a card we already
      // shipped — re-delivering it would open a SECOND PR for the same work.
      // Include delivery gate diagnostics when stopping for scope_in_flight,
      // so the operator sees a red main CI instead of the generic reason alone.
      if (allScopeCardsSettled(id.path, goal, progress)) {
        const dgLines = deliveryGateStopDetails(id.path, deps.nowSec());
        stopReason = dgLines.length > 0 ? `scope_in_flight:${dgLines[0]}` : "scope_in_flight";
        break;
      }
      const timeboxGate = applyTimeboxGate(id.path, bus, sid, goal, deps, deadlineSec);
      goal = timeboxGate.goal;
      if (timeboxGate.stopped) {
        stopReason = timeboxGate.reason;
        break;
      }

      if (hasSafetyPauseSince(evPath, startedSec)) {
        stopReason = "safety_pause";
        break;
      }
      if (!guided && existsSync(pauseMarkerPath(id.path, id.slug))) {
        stopReason = "pause_marker";
        break;
      }
      if (after.summary.cycles <= before.summary.cycles) {
        stopReason = noCycleTerminalReason(id.path, id.slug, startedSec);
        break;
      }
    }

    const finalReason = stopReason ?? "stop_requested";
    const finalGoal = finalReason === "waiting_capacity"
      ? goal
      : goal.status === "complete" || goal.status === "paused"
        ? goal
        : pauseGoal(id.path, bus, finalReason, deps.nowIso(), deps.nowSec()) ?? goal;
    bus.appendEvent(evPath, {
      type: "goal:session_end",
      sessionId: sid,
      status: finalGoal.status,
      reason: finalReason,
      cycles: finalGoal.usage.cycles - initialUsage.cycles,
      ts: deps.nowSec(),
    });
    process.stdout.write(`roll loop go: stopped at cycle boundary (${finalReason})\n`);
    return 0;
  } finally {
    disposeSignals();
    releaseLock(lockPath);
  }
}
