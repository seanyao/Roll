/**
 * US-V4-008 — `roll supervisor`: the project-level Supervisor, v0 (observe +
 * advise). It reads STRUCTURED facts via deterministic selectors — backlog, merge
 * truth (pr:merge events), open PRs, route config, repeated failures, release
 * readiness — then projects {@link SupervisorFacts} and emits advisory
 * {@link SupervisorDecision} records. It NEVER implements a Story, writes a Story
 * eval report, bypasses a gate, or marks a Story Done; persistent policy changes
 * are advisory and carry `requiresOwner`.
 *
 *   roll supervisor            # observe + advise summary
 *   roll supervisor observe    # structured facts
 *   roll supervisor advise     # decisions
 *   roll supervisor next       # "what should Roll do next?"
 *   roll supervisor why        # "why is the project stuck?"
 *   roll supervisor live       # read-only role board plus shared DeliveryRun truth
 *   roll supervisor --json     # machine-readable
 */
import {
  EventBus,
  acForStory,
  adviseProject,
  buildSupervisorRunbookState,
  buildCycleRoleSummary,
  buildSupervisorDeliveryRunBoard,
  buildSupervisorLiveBoard,
  classifyEvidenceRepair,
  cycleIdFromBranch,
  ensureDeliveriesFresh,
  explainStuck,
  gatherAgentToolchainIssues,
  generateAcMap,
  isEvidenceRepaired,
  normalizeAgentConfig,
  observeProject,
  parseBacklog,
  parseRollScoreArtifact,
  projectCollabStream,
  projectSupervisorMetrics,
  queryStoryDelivery,
  renderReport,
  repairedPrNumbers,
  resolveEvaluatorApproval,
  type ExecPort,
  type RollEvaluatorScore,
  recommendNext,
  summarizeAgentHealthIssues,
  type FreshnessPort,
} from "@roll/core";
import type { CastRoleName, CollabStreamView, CycleRoleSummary, EventSource, RollEvent, RollGoal, SupervisorInput } from "@roll/spec";
import { parseEventLine, parseGoalYaml, resolveLang } from "@roll/spec";
import { reduceStatusCheckRollup, type StatusCheckRollupEntry } from "@roll/infra";
import { detectNoProgressStall, type NoProgressStall } from "../lib/goal-recovery.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { supervisorJournalCommand } from "./supervisor-journal.js";
import { formatOperatingMode, resolveOperatingMode, suggestedGuidedRun } from "../lib/operating-mode.js";
import { collectBrowserTruth } from "../lib/browser-truth-collect.js";
import { renderBrowserTruthSupervisorLine } from "../lib/browser-truth-surface.js";
import { readPendingPublish } from "../runner/pending-publish.js";
import { cardArchiveDir, reportFileName, reviewFileName } from "../lib/archive.js";
import { readScopedAgentLayer, renderScopedExecuteRoute, resolveScopedCastRole, scopedExecuteRouteTrace } from "../runner/scoped-route.js";
import { renderCollabStream } from "../lib/collab-render.js";
import { auditWorktrees } from "./worktree-audit.js";

const EXEC_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SUPERVISOR_LIVE_WATCH_DEFAULT_INTERVAL_MS = 2_000;
const SUPERVISOR_LIVE_WATCH_MIN_INTERVAL_MS = 250;
const SUPERVISOR_DELIVERY_STALE_AFTER_MS = 5 * 60 * 1000;

export const SUPERVISOR_USAGE = [
  "Usage: roll supervisor [status|observe|advise|next|why|live|metrics|journal|health|route|repair-evidence] [--json]",
  "  status           observe + advise summary (alias for no subcommand)",
  "  observe          structured project facts (backlog, truth coverage, PRs, release readiness)",
  "  advise           Supervisor decisions (advisory; persistent changes need owner confirmation)",
  "  next             what should Roll do next?",
  "  why              why is the project stuck?",
  "  live             read-only Supervisor live board with Designer/Builder/Evaluator panes and shared DeliveryRun truth",
  "  live --watch     redraw the role board in-place until Ctrl-C; use --interval <sec>",
  "  live --collab    follow the multi-cycle collaboration stream; add --once for a snapshot",
  "  metrics          read-only queue, dependency, delivery, and reconciliation lag projection",
  "  journal          structured supervisor narrative stream: list/record decisions, verifications, rescues",
  "  health           agent toolchain health: auth/network/setup/worktree classification and routing",
  "  route            Role route trace: --role builder|designer|evaluator|peer_reviewer [--story <id>]",
  "  repair-evidence  repair missing acceptance evidence for a green PR and restore merge-ready status",
].join("\n");

export function supervisorUsage(): string {
  const zh = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] }) === "zh";
  return zh
    ? [
      "用法：roll supervisor [status|observe|advise|next|why|live|metrics|journal|health|route|repair-evidence] [--json]",
      "  status           observe + advise 摘要（无子命令的别名）",
      "  observe          项目结构化事实（backlog、真相覆盖、PR、发布就绪度）",
      "  advise           Supervisor 建议（持久化更改需 owner 确认）",
      "  next / why       下一步与阻塞原因",
      "  live             只读实时面板：Designer/Builder/Evaluator 和共同 DeliveryRun 真相",
      "  live --watch     原地重绘面板，Ctrl-C 退出；可用 --interval <sec>",
      "  live --collab    跟随多周期协作流；加 --once 读取快照",
      "  metrics          只读投影：排队、依赖、交付与对账耗时",
      "  journal          Supervisor 叙事流：列出/记录决策、验证、救援",
      "  health           agent 工具链健康：auth/network/setup/worktree 分类与路由",
      "  route            角色路由追踪：--role builder|designer|evaluator|peer_reviewer [--story <id>]",
      "  repair-evidence  修复绿色 PR 缺失的验收证据并恢复 merge-ready 状态",
    ].join("\n")
    : SUPERVISOR_USAGE;
}

function depsOf(desc: string): string[] {
  const m = /depends-on:\s*([A-Za-z0-9_,-]+)/i.exec(desc);
  return m === null ? [] : (m[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

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

const quietExecPort: ExecPort = {
  run(tool: string, argv: readonly string[]) {
    try {
      const stdout = execFileSync(tool, [...argv], {
        encoding: "utf8",
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { stdout: stdout.trim(), code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; status?: number | null };
      const out = e.stdout === undefined ? "" : e.stdout.toString();
      return { stdout: out.trim(), code: typeof e.status === "number" ? e.status : 1 };
    }
  },
};

function preservedWorktreeHasChanges(projectPath: string, cycleId: string): boolean {
  const worktreePath = join(projectPath, ".roll", "loop", "worktrees", `cycle-${cycleId}`);
  if (!existsSync(worktreePath)) return true;
  try {
    return execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() !== "";
  } catch {
    return true;
  }
}

function summarizeList(items: readonly string[], limit = 5): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, limit).join(", ");
  const remaining = items.length - limit;
  return remaining > 0 ? `${shown}, … +${remaining} more` : shown;
}

function readRollMetaState(projectPath: string): NonNullable<SupervisorInput["rollMeta"]> {
  const rollDir = join(projectPath, ".roll");
  if (!existsSync(rollDir)) return { state: "unknown", detail: ".roll directory is missing" };
  const res = quietExecPort.run("git", ["-C", rollDir, "status", "--short"]);
  if (res.code !== 0) return { state: "unknown", detail: ".roll is not a readable git repo" };
  const files = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return files.length === 0
    ? { state: "clean", detail: "roll-meta clean", files: [] }
    : { state: "dirty", detail: `${files.length} dirty roll-meta file(s)`, files };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStoryIdToken(value: string, storyId: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(storyId)}($|[^A-Za-z0-9])`).test(value);
}

function extractStoryId(knownStoryIds: readonly string[], ...values: readonly string[]): string | undefined {
  const known = [...new Set(knownStoryIds)].sort((a, b) => b.length - a.length);
  for (const value of values) {
    const knownMatch = known.find((id) => hasStoryIdToken(value, id));
    if (knownMatch !== undefined) return knownMatch;
    const match = /\b(?:US|FIX|REFACTOR)-[A-Za-z0-9_-]+\b/.exec(value);
    if (match !== null) return match[0];
  }
  return undefined;
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function actionForManualMerge(facts: { bot: string; ciState: string; mergeable: string; isDraft?: boolean }, repaired?: boolean): string {
  // FIX-1058 — evidence-repaired PRs show merge_ready regardless of draft status.
  if (repaired === true) return "merge_ready";
  if (facts.isDraft === true) {
    if (facts.bot === "APPROVED" && facts.ciState === "success" && facts.mergeable === "CLEAN") return "ready_to_promote_and_merge";
    return "draft_manual_merge_waiting";
  }
  if (facts.bot === "APPROVED" && facts.ciState === "success" && facts.mergeable === "CLEAN") return "manual_merge_required";
  if (facts.ciState === "failure") return "ci_red_before_manual_merge";
  if (facts.mergeable === "BEHIND" || facts.mergeable === "DIRTY" || facts.mergeable === "CONFLICTING") return "rebase_or_conflict_before_manual_merge";
  return "manual_merge_waiting";
}

/**
 * FIX-1061 — resolve the Roll evaluator score for a manual-merge PR from Roll's
 * own evidence. Loop PRs carry their authoritative evaluator verdict as a
 * `cycle-<id>.score.pair.json` peer artifact (and a `pair:score` event), not as
 * a GitHub review. The cycle id is read from the PR head branch (`loop/cycle-<id>`);
 * the artifact file is primary, the latest matching `pair:score` event is the
 * fallback. Returns null when no cycle or no parseable score is found (fail-loud:
 * the caller then relies on GitHub review state alone).
 */
function resolveRollEvaluatorScore(
  projectPath: string,
  headRefName: string | undefined,
  events: readonly RollEvent[],
): RollEvaluatorScore | null {
  const cycleId = cycleIdFromBranch(headRefName);
  if (cycleId === null) return null;

  // Primary: the peer score artifact written by the score stage.
  const artifactPath = join(projectPath, ".roll", "loop", "peer", `cycle-${cycleId}.score.pair.json`);
  if (existsSync(artifactPath)) {
    try {
      const parsed = parseRollScoreArtifact(JSON.parse(readFileSync(artifactPath, "utf8")));
      if (parsed !== null) return parsed;
    } catch {
      // Fall through to the event fallback — an unreadable/garbled artifact is
      // not fatal; the event stream may still carry the score.
    }
  }

  // Fallback: the latest `pair:score` event for this cycle's score stage.
  let latest: RollEvaluatorScore | null = null;
  let latestTs = -1;
  for (const ev of events) {
    if (ev.type === "pair:score" && ev.cycleId === cycleId && ev.stage === "score" && ev.ts > latestTs) {
      latest = { score: ev.score, verdict: ev.verdict };
      latestTs = ev.ts;
    }
  }
  return latest;
}

export function readManualMergeGates(
  projectPath: string,
  events: readonly RollEvent[],
  port: ExecPort = quietExecPort,
  knownStoryIds: readonly string[] = [],
  repairedPrSet?: ReadonlySet<number>,
): NonNullable<SupervisorInput["manualMergeGates"]> {
  const list = port.run("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName,title"]);
  const prs = list.code === 0 ? parseJsonArray(list.stdout) : [];
  if (prs.length === 0) return [];

  const prStory = new Map<number, string>();
  for (const ev of events) {
    if (ev.type === "pr:open") prStory.set(ev.prNumber, ev.storyId);
  }

  const gates: Array<NonNullable<SupervisorInput["manualMergeGates"]>[number]> = [];
  for (const item of prs) {
    const pr = item as { number?: number; headRefName?: string; title?: string };
    if (typeof pr.number !== "number") continue;
    const view = port.run("gh", [
      "pr",
      "view",
      String(pr.number),
      "--json",
      "reviews,mergeStateStatus,statusCheckRollup,body,labels,isDraft",
    ]);
    if (view.code !== 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(view.stdout) as unknown;
    } catch {
      continue;
    }
    const body = typeof (raw as { body?: unknown }).body === "string" ? ((raw as { body?: string }).body ?? "") : "";
    const reviews: Array<{ authorAssociation?: string; state?: string }> = ((raw as { reviews?: unknown }).reviews ?? []) as Array<{ authorAssociation?: string; state?: string }>;
    const botReviews = reviews.filter(
      (r) => r.authorAssociation === "BOT" || r.authorAssociation === "APP",
    );
    const lastBot = botReviews.length > 0 ? botReviews[botReviews.length - 1] : undefined;
    const facts = {
      bot: lastBot?.state ?? "",
      ciState: (() => {
        const rollup = ((raw as { statusCheckRollup?: StatusCheckRollupEntry[] }).statusCheckRollup ?? []);
        const state = reduceStatusCheckRollup(rollup);
        if (state === "green") return "success";
        if (state === "red") return "failure";
        return "";
      })(),
      mergeable: (raw as { mergeStateStatus?: string }).mergeStateStatus ?? "",
      manualMerge:
        ((raw as { body?: string }).body ?? "").includes("[roll:manual-merge]") ||
        ((raw as { labels?: Array<{ name?: string }> }).labels ?? []).some((label) => label.name === "manual-merge" || label.name === "roll:manual-merge"),
      isDraft: (raw as { isDraft?: boolean }).isDraft === true,
    };
    if (facts.manualMerge !== true) continue;
    const storyId = prStory.get(pr.number) ?? extractStoryId(knownStoryIds, pr.headRefName ?? "", pr.title ?? "", body) ?? `PR-${pr.number}`;
    const repaired = repairedPrSet !== undefined && isEvidenceRepaired(pr.number, repairedPrSet);
    const action = actionForManualMerge(facts, repaired);
    // FIX-1061 — name the evaluator source (GitHub review or Roll evaluator score)
    // instead of a bare `evaluator=none` when a loop PR carries a Roll score.
    const rollScore = resolveRollEvaluatorScore(projectPath, pr.headRefName, events);
    const approval = resolveEvaluatorApproval({ reviewState: facts.bot || "none", rollEvaluatorScore: rollScore });
    const baseEvaluatorLabel =
      approval.source === "roll-score"
        ? `roll-score(${approval.detail})`
        : approval.source === "github-review"
          ? `github-review(${facts.bot || "none"})`
          : facts.bot || "none";
    // FIX-1062 — when evidence has been repaired, the diagnostic must explain that
    // merge readiness comes from repaired evidence and must not read as a bare
    // `evaluator=none` when there is no GitHub review/Roll score approval.
    const evaluatorLabel = repaired
      ? approval.approved
        ? `${baseEvaluatorLabel} · evidence-repaired`
        : `evidence-repaired (no separate evaluator approval)`
      : baseEvaluatorLabel;
    gates.push({
      storyId,
      prNumber: pr.number,
      ciState: facts.ciState || "unknown",
      reviewState: facts.bot || "none",
      mergeable: facts.mergeable || "unknown",
      action,
      detail: `ci=${facts.ciState || "unknown"} evaluator=${evaluatorLabel} merge=${facts.mergeable || "unknown"} action=${action}`,
      source: `gh pr view ${pr.number}`,
    });
  }
  return gates;
}

/** Gather the Supervisor's structured input from project state (deterministic). */
export function gatherSupervisorInput(projectPath: string): SupervisorInput {
  const backlogPath = join(projectPath, ".roll", "backlog.md");
  const backlog = existsSync(backlogPath)
    ? parseBacklog(readFileSync(backlogPath, "utf8")).map((it) => ({ id: it.id, status: it.status, dependsOn: depsOf(it.desc) }))
    : [];

  const agentsPath = join(projectPath, ".roll", "agents.yaml");
  const routeConfigErrors = existsSync(agentsPath) ? normalizeAgentConfig(readFileSync(agentsPath, "utf8")).errors : [];

  // Merge truth + PR/failure facts from the durable event stream.
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  let events: RollEvent[] = [];
  try {
    if (existsSync(eventsPath)) events = new EventBus().readEvents(eventsPath);
  } catch {
    events = [];
  }
  const merged = new Set<string>();
  const opened = new Set<string>();
  const cycleStory = new Map<string, string>();
  const failuresByStory = new Map<string, number>();
  const structuralFailures = new Map<string, NonNullable<SupervisorInput["structuralFailures"]>[number]>();
  const FAIL = new Set(["failed", "gave_up", "blocked", "aborted"]);
  for (const ev of events) {
    if (ev.type === "pr:merge") merged.add(ev.storyId);
    else if (ev.type === "pr:open") opened.add(ev.storyId);
    else if (ev.type === "cycle:start") cycleStory.set(ev.cycleId, ev.storyId);
    else if (ev.type === "sandbox:main_dirty") {
      const sid = cycleStory.get(ev.cycleId);
      if (sid !== undefined) {
        structuralFailures.set(sid, {
          storyId: sid,
          kind: "main_checkout_dirty",
          detail: `main checkout dirty at ${ev.phase}; files: ${ev.files.join(", ") || "unknown"}`,
          source: `sandbox:main_dirty/${ev.cycleId}`,
        });
      }
    }
    else if (ev.type === "sandbox:quarantined") {
      const sid = ev.storyId ?? cycleStory.get(ev.cycleId);
      if (sid !== undefined) {
        structuralFailures.set(sid, {
          storyId: sid,
          kind: "main_checkout_dirty",
          detail: `main checkout ${ev.reason} quarantined at ${ev.phase}; ref ${ev.ref}; manifest ${ev.manifestPath}`,
          source: `sandbox:quarantined/${ev.cycleId}`,
        });
      }
    }
    else if (ev.type === "cycle:end") {
      const sid = cycleStory.get(ev.cycleId);
      if (sid !== undefined) {
        // consecutive trailing failures: reset on a non-failure terminal.
        failuresByStory.set(sid, FAIL.has(ev.outcome) ? (failuresByStory.get(sid) ?? 0) + 1 : 0);
        if (ev.outcome === "handoff_without_tcr" && preservedWorktreeHasChanges(projectPath, ev.cycleId)) {
          structuralFailures.set(sid, {
            storyId: sid,
            kind: "zero_tcr_dirty_worktree",
            detail: "zero TCR with dirty preserved worktree; owner must inspect or rescue before retry",
            source: `cycle:end/${ev.cycleId}`,
            worktreePath: `.roll/loop/worktrees/cycle-${ev.cycleId}`,
          });
        }
      }
    }
    else if (ev.type === "builder:boundary_violation") {
      const sid = ev.storyId !== "" ? ev.storyId : cycleStory.get(ev.cycleId);
      if (sid !== undefined) {
        structuralFailures.set(sid, {
          storyId: sid,
          kind: "main_checkout_dirty",
          detail:
            (ev.leakedCommits ?? 0) > 0
              ? `main checkout ahead of origin/main by ${ev.leakedCommits} commit(s); attempted cwd: ${ev.attemptedCwd ?? "unknown"}; expected worktree: ${ev.expectedWorktreeCwd ?? ev.worktreePath}`
              : `main checkout dirty at finalization; files: ${ev.files.join(", ") || "unknown"}`,
          source: `builder:boundary_violation/${ev.cycleId}`,
          worktreePath: ev.worktreePath,
        });
      }
    }
    else if (
      ev.type === "builder:handoff_required" &&
      preservedWorktreeHasChanges(projectPath, ev.cycleId)
    ) {
      const sid = ev.storyId !== "" ? ev.storyId : cycleStory.get(ev.cycleId);
      if (sid !== undefined) {
        structuralFailures.set(sid, {
          storyId: sid,
          kind: "zero_tcr_dirty_worktree",
          detail: "zero TCR with dirty preserved worktree; owner must inspect or rescue before retry",
          source: `builder:handoff_required/${ev.cycleId}`,
          worktreePath: ev.worktreePath,
        });
      }
    }
  }

  try {
    const deliveries = ensureDeliveriesFresh(projectPath, nodeFreshnessPort, quietExecPort);
    for (const row of backlog) {
      if (queryStoryDelivery(row.id, deliveries).delivered) merged.add(row.id);
    }
  } catch {
    // Keep Supervisor observe usable in partial/non-git projects; event truth is
    // still consumed above, and missing delivery truth is rendered as coverage.
  }

  const openPrStories = [...opened].filter((s) => !merged.has(s));
  const recentFailures = [...failuresByStory.entries()]
    .filter(([, n]) => n > 0)
    .map(([storyId, consecutiveFailures]) => ({ storyId, consecutiveFailures }));

  const repairedPrSet = repairedPrNumbers(events);

  return {
    backlog,
    delivered: [...merged],
    openPrStories,
    recentFailures,
    routeConfigErrors,
    releaseBlockers: [],
    rollMeta: readRollMetaState(projectPath),
    manualMergeGates: readManualMergeGates(projectPath, events, quietExecPort, backlog.map((row) => row.id), repairedPrSet),
    structuralFailures: [...structuralFailures.values()],
    // FIX-1043 — surface the runner's pending-publish hold so supervisor
    // next/why agree with the picker's `all_pending_publish` idle.
    pendingPublish: [...readPendingPublish(join(projectPath, ".roll", "loop"))],
    agentHealthIssues: gatherAgentToolchainIssues(events),
  };
}

function remainingLine(input: SupervisorInput): string {
  const s = buildSupervisorRunbookState(input).scope.remainingByFamily;
  return `FIX ${s.FIX} · US ${s.US} · REFACTOR ${s.REFACTOR}`;
}

function latestCycleStart(events: readonly RollEvent[]): Extract<RollEvent, { type: "cycle:start" }> | undefined {
  const starts = events.filter((ev): ev is Extract<RollEvent, { type: "cycle:start" }> => ev.type === "cycle:start").sort((a, b) => b.ts - a.ts);
  return starts[0];
}

function latestExecutionCast(projectPath: string, events: readonly RollEvent[]): CycleRoleSummary | undefined {
  const latest = latestCycleStart(events);
  if (latest === undefined) return undefined;
  return buildCycleRoleSummary({
    cycleId: latest.cycleId,
    events,
    eventsPath: join(projectPath, ".roll", "loop", "events.ndjson"),
    peerDir: join(projectPath, ".roll", "loop", "peer"),
    cycleLogDir: join(projectPath, ".roll", "loop", "cycle-logs"),
  });
}

function latestCastSummary(events: readonly RollEvent[]): string {
  const latest = latestCycleStart(events);
  if (latest === undefined) return "none";
  const cycleEvents = events.filter((ev) => "cycleId" in ev && ev.cycleId === latest.cycleId);
  const score = [...cycleEvents]
    .reverse()
    .find((ev): ev is Extract<RollEvent, { type: "pair:score" }> => ev.type === "pair:score");
  const verdict = [...cycleEvents]
    .reverse()
    .find((ev): ev is Extract<RollEvent, { type: "pair:verdict" }> => ev.type === "pair:verdict");
  const selectedScore = [...cycleEvents]
    .reverse()
    .find((ev): ev is Extract<RollEvent, { type: "pair:selected" }> => ev.type === "pair:selected" && ev.stage === "score");
  const evaluator = score?.peer ?? verdict?.peer ?? selectedScore?.peer ?? "-";
  return `${latest.cycleId} · ${latest.storyId} · builder=${latest.agent} · evaluator=${evaluator}`;
}

function describeRole(role: CycleRoleSummary["roles"][number]): string {
  const agent = role.agent ?? "-";
  const result = role.score !== undefined ? `${role.state}/${role.score}` : role.verdict !== undefined ? `${role.state}/${role.verdict}` : role.state;
  const cause = role.cause !== undefined ? `/${role.cause}` : "";
  return `${agent}:${result}${cause}`;
}

function latestCastDetail(projectPath: string, events: readonly RollEvent[]): string {
  const cast = latestExecutionCast(projectPath, events);
  if (cast === undefined) return "none";
  const reviewers = cast.roles.filter((r) => r.role === "peer_reviewer").map(describeRole);
  const evaluators = cast.roles.filter((r) => r.role === "evaluator").map(describeRole);
  const gates = [
    cast.gates.peerGate !== undefined ? `peer=${cast.gates.peerGate}` : undefined,
    cast.gates.attestGate !== undefined ? `attest=${cast.gates.attestGate}` : undefined,
    cast.gates.delivery !== undefined ? `delivery=${cast.gates.delivery}` : undefined,
  ].filter((v): v is string => v !== undefined);
  const sources = cast.sources.length === 0 ? "none" : summarizeList(cast.sources, 3);
  return `reviewers=${reviewers.length === 0 ? "none" : reviewers.join(", ")} · evaluators=${evaluators.length === 0 ? "none" : evaluators.join(", ")} · gates=${gates.length === 0 ? "none" : gates.join(", ")} · sources=${sources}`;
}

function latestGateState(events: readonly RollEvent[]): string {
  const board = buildSupervisorLiveBoard(events, { recentLimit: 1 });
  const row = board.rows[0];
  if (row === undefined) return "no active/recent cycle";
  return row.status;
}

function manualMergeLine(input: SupervisorInput): string {
  const gates = input.manualMergeGates ?? [];
  if (gates.length === 0) return "none";
  return summarizeList(gates.map((g) => `PR #${g.prNumber}:${g.storyId}:${g.action} (${g.detail})`), 3);
}

interface PickRankingSummary {
  source: "agent" | "cache";
  picked: string;
  top3: Array<{ id: string; score: number; reason: string }>;
  line: string;
}

function latestPickRanking(events: readonly RollEvent[]): PickRankingSummary | null {
  let latest: Extract<RollEvent, { type: "pick:ranked" }> | undefined;
  for (const ev of events) {
    if (ev.type !== "pick:ranked") continue;
    if (latest === undefined || ev.ts >= latest.ts) latest = ev;
  }
  if (latest === undefined) return null;
  const top3 = [...latest.ranking]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((row) => ({ id: row.id, score: row.score, reason: row.reason }));
  const line = top3.length === 0
    ? "none"
    : top3.map((row, index) => `${index + 1}. ${row.id} ${row.score} — ${row.reason}`).join("; ");
  return { source: latest.source, picked: latest.picked, top3, line };
}

function supervisorContext(
  projectPath: string,
  input: SupervisorInput,
  events: readonly RollEvent[],
): {
  cast: string;
  castDetail: string;
  executionCast: CycleRoleSummary | null;
  gate: string;
  rollMeta: NonNullable<SupervisorInput["rollMeta"]>;
  manualMerge: string;
  pickRanking: PickRankingSummary | null;
} {
  return {
    cast: latestCastSummary(events),
    castDetail: latestCastDetail(projectPath, events),
    executionCast: latestExecutionCast(projectPath, events) ?? null,
    gate: latestGateState(events),
    rollMeta: input.rollMeta ?? { state: "unknown", detail: "not gathered" },
    manualMerge: manualMergeLine(input),
    pickRanking: latestPickRanking(events),
  };
}

type SupervisorContext = ReturnType<typeof supervisorContext>;

function compactContextForJson(ctx: SupervisorContext): Omit<SupervisorContext, "executionCast"> {
  return {
    cast: ctx.cast,
    castDetail: ctx.castDetail,
    gate: ctx.gate,
    rollMeta: ctx.rollMeta,
    manualMerge: ctx.manualMerge,
    pickRanking: ctx.pickRanking,
  };
}

function fmtFacts(input: SupervisorInput, events: readonly RollEvent[] = []): string {
  const f = observeProject(input);
  const runbook = buildSupervisorRunbookState(input);
  const liveStuck = runbook.blockedCards.filter((b) => b.reason === "repeated_failure").map((b) => b.storyId);
  const ctx = supervisorContext(process.cwd(), input, events);
  const mode = resolveOperatingMode(process.cwd());
  const truthCoverage =
    f.truthDrift.length === 0
      ? "complete"
      : `partial — ${f.truthDrift.length} Done row(s) lack structured delivery truth (${summarizeList(f.truthDrift)}); run roll truth audit for detail`;
  const lines = [
    "",
    "  Supervisor — project facts (observe)",
    "",
    `    scope: ${runbook.scope.label}`,
    `    remaining: ${remainingLine(input)}`,
    `    selected: ${runbook.next.storyId ?? "(nothing ready)"} — ${runbook.next.kind}`,
    `    blocked: ${runbook.blockedCards.length === 0 ? "none" : summarizeList(runbook.blockedCards.map((b) => `${b.storyId}:${b.reason}`))}`,
    `    agent health: ${runbook.agentHealth.summary}`,
    `    cast: ${ctx.cast}`,
    `    cast detail: ${ctx.castDetail}`,
    `    gate: ${ctx.gate}`,
    `    manual merge: ${ctx.manualMerge}`,
    `    .roll meta: ${ctx.rollMeta.state} — ${ctx.rollMeta.detail}`,
    `    backlog: ${f.counts.todo} todo · ${f.counts.inProgress} in-progress · ${f.counts.blocked} blocked · ${f.counts.done} done`,
    `    open PRs: ${f.openPrCount}`,
    `    truth coverage: ${truthCoverage}`,
    `    stuck stories: ${liveStuck.length === 0 ? "none in live scope" : summarizeList(liveStuck)}`,
    `    route config: ${f.routeConfigErrors.length === 0 ? "ok" : summarizeList(f.routeConfigErrors)}`,
    `    release: ${f.releaseReadiness.ready ? "ready" : "blocked — " + summarizeList(f.releaseReadiness.blockers)}`,
    `    budget: ${f.budgetHealth.note}`,
    `    ${formatOperatingMode(mode)}`,
    `    owner action: ${mode.ownerAction}`,
    "",
  ];
  return lines.join("\n") + "\n";
}

function fmtAdvice(input: SupervisorInput): string {
  const decisions = supervisorDecisions(input);
  if (decisions.length === 0) return "\n  Supervisor — no advisory decisions (project healthy)\n\n";
  const rows = decisions.map((d) => `    [${d.kind}]${d.requiresOwner ? " (owner confirmation required)" : ""} ${d.reason}`);
  return ["", "  Supervisor — advisory decisions", "", ...rows, ""].join("\n") + "\n";
}

function supervisorDecisions(input: SupervisorInput): ReturnType<typeof adviseProject> {
  const runbook = buildSupervisorRunbookState(input);
  const hasLiveStuck = runbook.blockedCards.some((b) => b.reason === "repeated_failure");
  return adviseProject(observeProject(input)).filter((d) => hasLiveStuck || !d.reason.startsWith("stuck stories"));
}

type SupervisorRunbookState = ReturnType<typeof buildSupervisorRunbookState>;

function compactRunbookForJson(runbook: SupervisorRunbookState): {
  scope: {
    label: string;
    families: readonly string[];
    remainingByFamily: SupervisorRunbookState["scope"]["remainingByFamily"];
    todoByFamily: SupervisorRunbookState["scope"]["todoByFamily"];
  };
  next: SupervisorRunbookState["next"];
  blockedCards: SupervisorRunbookState["blockedCards"];
  truth: {
    manualMergeGates: SupervisorRunbookState["truth"]["manualMergeGates"];
    structuralFailures: SupervisorRunbookState["truth"]["structuralFailures"];
  };
  agentHealth: { summary: string };
} {
  return {
    scope: {
      label: runbook.scope.label,
      families: runbook.scope.families,
      remainingByFamily: runbook.scope.remainingByFamily,
      todoByFamily: runbook.scope.todoByFamily,
    },
    next: runbook.next,
    blockedCards: runbook.blockedCards,
    truth: {
      manualMergeGates: runbook.truth.manualMergeGates,
      structuralFailures: runbook.truth.structuralFailures,
    },
    agentHealth: { summary: runbook.agentHealth.summary },
  };
}

function runbookWhy(state: ReturnType<typeof buildSupervisorRunbookState>, facts: ReturnType<typeof observeProject>): string {
  if (state.next.kind === "diagnose_failure") {
    const structural = state.truth.structuralFailures?.find((f) => f.storyId === state.next.storyId);
    if (structural?.worktreePath !== undefined) {
      return `${state.next.reason}; worktree: ${structural.worktreePath}`;
    }
    return state.next.reason;
  }
  if (state.next.kind === "run_card") return `not stuck: next live card is ${state.next.storyId}`;
  return state.next.reason;
}

/**
 * FIX-1049 — read the persisted goal and, when the no-progress breaker stopped
 * it, project the supervised-recovery facts. Returns `undefined` for any other
 * state so `why` only surfaces the recovery block when there is a stall to act on.
 */
function readNoProgressStall(projectPath: string, events: readonly RollEvent[]): NoProgressStall | undefined {
  const goalPath = join(projectPath, ".roll", "loop", "goal.yaml");
  if (!existsSync(goalPath)) return undefined;
  let goal: RollGoal | undefined;
  try {
    goal = parseGoalYaml(readFileSync(goalPath, "utf8"));
  } catch {
    return undefined;
  }
  return detectNoProgressStall(goal, events);
}

/** Render the no-progress recovery facts (AC1) — blocked card, streak, last/next
 *  Builder, handoff to inspect, and the recovery command. */
function fmtNoProgressRecovery(stall: NoProgressStall): string {
  const streaks = Object.entries(stall.zeroStreaks);
  const streakLine = streaks.length === 0 ? "none recorded" : streaks.map(([id, n]) => `${id}=${n}`).join(", ");
  const target = stall.blockedCards[0] ?? "<story-id>";
  const lines = [
    "  no-progress recovery:",
    `    stopped by: ${stall.reason}`,
    `    blocked cards: ${stall.blockedCards.length === 0 ? "(whole-goal breaker)" : stall.blockedCards.join(", ")}`,
    `    zero-delivery streak: ${streakLine} · whole-goal no-progress cycles: ${stall.noProgressCycles}`,
    `    last failed Builder: ${stall.lastBuilder ?? "(unknown)"}`,
  ];
  if (stall.handoff !== undefined) {
    lines.push(
      `    handoff: cycle ${stall.handoff.cycleId} — ${stall.handoff.detail} (roll loop log ${stall.handoff.cycleId})`,
      `      kind: ${stall.handoff.kind}`,
      `      worktree: ${stall.handoff.worktreePath}`,
    );
  }
  lines.push(`    recover: roll loop recover ${target} (preview) · roll loop recover ${target} --apply --reason "<why>"`);
  return lines.join("\n");
}

function readSupervisorEvents(projectPath: string): RollEvent[] {
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  try {
    if (existsSync(eventsPath)) return new EventBus().readEvents(eventsPath);
  } catch {
    return [];
  }
  return [];
}

function readSupervisorMetricEvents(projectPath: string): { events: RollEvent[]; diagnostics: string[] } {
  const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
  if (!existsSync(eventsPath)) return { events: [], diagnostics: ["event ledger unavailable: .roll/loop/events.ndjson"] };
  try {
    const events: RollEvent[] = [];
    const diagnostics: string[] = [];
    for (const [index, raw] of readFileSync(eventsPath, "utf8").split("\n").entries()) {
      if (raw.trim() === "") continue;
      const event = parseEventLine(raw);
      if (event === null) diagnostics.push(`invalid event ledger line ${eventsPath}:${index + 1} (metrics incomplete)`);
      else events.push(event);
    }
    return { events, diagnostics };
  } catch {
    return { events: [], diagnostics: [`cannot read event ledger ${eventsPath}`] };
  }
}

function formatSupervisorMetricMs(value: number | null): string {
  if (value === null) return "?";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
}

function formatSupervisorIncompleteFact(value: string, zh: boolean): string {
  if (!zh) return value;
  const translations: ReadonlyArray<readonly [string, string]> = [
    ["queue wait unavailable", "排队等待不可用"], ["first-action latency unavailable", "首个动作延迟不可用"],
    ["dispatch-to-merge lead unavailable", "派发至合并耗时不可用"], ["PR/CI tail unavailable", "PR/CI 尾段不可用"],
    ["reconciliation lag unavailable", "对账滞后不可用"], ["dependency wait unavailable", "依赖等待不可用"],
    ["dependency wait incomplete", "依赖等待不完整"], ["recorded main merge evidence unavailable", "已记录的 main 合并证据不可用"],
    ["backlog status unavailable", "backlog 状态不可用"], ["attestation state unavailable", "attest 状态不可用"],
    ["handoff_ready observed: not a main merge, attestation verdict, or Delivered claim", "已观察到 handoff_ready：它不是 main 合并、attest 裁定或已交付声明"],
    ["missing ranked-ready or dispatch observation", "缺少已排序就绪或派发观察"], ["missing dispatch or first-action observation", "缺少派发或首个动作观察"],
    ["missing dispatch or recorded main merge evidence", "缺少派发或已记录的 main 合并证据"], ["missing PR-open and CI-or-main observation", "缺少 PR 打开及 CI 或 main 观察"],
    ["missing main merge or reconciliation observation", "缺少 main 合并或对账观察"], ["missing dependency-block observation timestamp", "缺少依赖阻塞观察时间戳"],
    ["blocked-by-not-Done has no later dispatch observation", "未完成依赖阻塞后没有后续派发观察"], ["dependencies are Done but dispatch boundary is unavailable", "依赖已完成但派发边界不可用"],
    ["backlog card unavailable: dependency state unknown", "backlog 卡片不可用：依赖状态未知"], ["timestamp inversion", "时间戳倒置"],
  ];
  return translations.reduce((text, [from, to]) => text.replace(from, to), value);
}

export function renderSupervisorMetrics(report: ReturnType<typeof projectSupervisorMetrics>, language = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] })): string {
  const zh = language === "zh";
  const window = report.observationWindow.fromTs === null
    ? (zh ? "无已记录事件" : "no observed events")
    : `${report.observationWindow.fromTs}..${report.observationWindow.toTs}`;
  const a = report.aggregates;
  const line = (label: string, value: { readonly sampleSize: number; readonly totalMs: number | null; readonly p50Ms: number | null; readonly p95Ms: number | null }): string =>
    `${label}: ${formatSupervisorMetricMs(value.totalMs)}; ${zh ? "样本" : "sample"} ${value.sampleSize}, P50 ${formatSupervisorMetricMs(value.p50Ms)}, P95 ${formatSupervisorMetricMs(value.p95Ms)}`;
  const lines = zh
    ? [
      `窗口：${window}（按事件记录时间）`,
      `样本：${report.sampleSize} 张卡；真相核对 ${report.truthConsistency.checked}（一致 ${report.truthConsistency.consistent}，不一致 ${report.truthConsistency.inconsistent}，不完整 ${report.truthConsistency.incomplete}）`,
      line("排队等待", a.queueWait), line("依赖等待", a.dependencyWait), line("首个动作延迟", a.firstActionLatency),
      line("派发至合并", a.dispatchToMergeLead), line("PR/CI 尾段", a.prCiTail), line("对账滞后", a.reconciliationLag),
      `依赖状态：未完成阻塞 ${report.dependencyStates.blocked_by_not_done}，已满足未派发 ${report.dependencyStates.not_yet_dispatched}，未知 ${report.dependencyStates.unknown}`,
      `百分位算法：nearest-rank；数据${report.incomplete ? `不完整（${report.diagnostics.length} 条来源提示；逐卡列出缺失事实）` : "完整"}`,
      "注意：handoff_ready 不是已交付、main 合并或 attest 裁定。",
    ]
    : [
      `window: ${window} (observed event time)`,
      `sample: ${report.sampleSize} cards; truth checked ${report.truthConsistency.checked} (${report.truthConsistency.consistent} consistent, ${report.truthConsistency.inconsistent} inconsistent, ${report.truthConsistency.incomplete} incomplete)`,
      line("queue wait", a.queueWait), line("dependency wait", a.dependencyWait), line("first-action latency", a.firstActionLatency),
      line("dispatch-to-merge lead", a.dispatchToMergeLead), line("PR/CI tail", a.prCiTail), line("reconciliation lag", a.reconciliationLag),
      `dependency states: blocked-by-not-Done ${report.dependencyStates.blocked_by_not_done}, satisfied-not-dispatched ${report.dependencyStates.not_yet_dispatched}, unknown ${report.dependencyStates.unknown}`,
      `percentiles: nearest-rank; data ${report.incomplete ? `incomplete (${report.diagnostics.length} source diagnostics; every missing fact is listed per card)` : "complete"}`,
      "Note: handoff_ready is not Delivered, a main merge, or an attest verdict.",
    ];
  const incomplete = report.cards.flatMap((card) => card.incompleteFacts.length === 0
    ? []
    : [`  ${zh ? "缺失事实" : "incomplete facts"} [${card.storyId}]: ${card.incompleteFacts.map((fact) => formatSupervisorIncompleteFact(fact, zh)).join("; ")}`]);
  const sourceDiagnostics = report.diagnostics.map((diagnostic) => `  ${zh ? "来源提示" : "source diagnostic"}: ${formatSupervisorIncompleteFact(diagnostic, zh)}`);
  return `${[zh ? "Supervisor 指标（只读）" : "Supervisor metrics (read-only)", "", ...lines.map((value) => `  ${value}`), ...sourceDiagnostics, ...incomplete].join("\n")}\n`;
}

function supervisorMetricsCommand(args: readonly string[], projectPath: string): number {
  const invalid = args.find((arg) => arg !== "metrics" && arg !== "--json" && arg !== "--no-color");
  if (invalid !== undefined) {
    process.stderr.write("Usage: roll supervisor metrics [--json]\n");
    return 1;
  }
  const backlogPath = join(projectPath, ".roll", "backlog.md");
  const backlog = existsSync(backlogPath)
    ? parseBacklog(readFileSync(backlogPath, "utf8")).map((card) => ({ id: card.id, status: card.status, dependsOn: depsOf(card.desc) }))
    : [];
  const input = readSupervisorMetricEvents(projectPath);
  const report = projectSupervisorMetrics({ events: input.events, backlog, sourceDiagnostics: input.diagnostics });
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderSupervisorMetrics(report));
  return 0;
}

function cycleEventId(ev: RollEvent): string | undefined {
  return "cycleId" in ev && typeof (ev as { cycleId?: unknown }).cycleId === "string"
    ? (ev as { cycleId: string }).cycleId
    : undefined;
}

function cycleStarted(events: readonly RollEvent[], cycleId: string): boolean {
  return events.some((ev) => cycleEventId(ev) === cycleId && ev.type === "cycle:start");
}

function collabCycleIds(events: readonly RollEvent[]): string[] {
  const firstSeen = new Map<string, number>();
  for (const ev of events) {
    const cycleId = cycleEventId(ev);
    if (cycleId === undefined || firstSeen.has(cycleId)) continue;
    firstSeen.set(cycleId, ev.ts);
  }
  return [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([cycleId]) => cycleId);
}

function readCycleRoleSummary(projectPath: string, cycleId: string): CycleRoleSummary | null {
  const summaryPath = join(projectPath, ".roll", "loop", "cycle-logs", cycleId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, "utf8")) as CycleRoleSummary;
  } catch {
    return null;
  }
}

function rebuildCycleRoleSummary(projectPath: string, events: readonly RollEvent[], cycleId: string): CycleRoleSummary | null {
  if (!cycleStarted(events, cycleId)) return null;
  return buildCycleRoleSummary({
    cycleId,
    events,
    eventsPath: join(projectPath, ".roll", "loop", "events.ndjson"),
    peerDir: join(projectPath, ".roll", "loop", "peer"),
    cycleLogDir: join(projectPath, ".roll", "loop", "cycle-logs"),
  });
}

function fallbackCollabScope(): string {
  return "live non-Hold FIX/US/REFACTOR";
}

function formatGoalScope(scope: RollGoal["scope"]): string {
  switch (scope.kind) {
    case "all":
      return "all";
    case "epic":
      return `epic: ${scope.epic}`;
    case "cards":
      return `cards: ${scope.cards.join(", ")}`;
  }
}

function collabGoalScope(projectPath: string): string {
  const goalPath = join(projectPath, ".roll", "loop", "goal.yaml");
  if (!existsSync(goalPath)) return fallbackCollabScope();
  try {
    return formatGoalScope(parseGoalYaml(readFileSync(goalPath, "utf8")).scope);
  } catch {
    return fallbackCollabScope();
  }
}

/**
 * FIX-1262 — resolve the Supervisor's agent identity from CONFIGURATION, not a
 * source-baked 'codex' hidden behind an undocumented env knob. Priority:
 *   1. `ROLL_SUPERVISOR_AGENT` — an explicit operator OVERRIDE only;
 *   2. the `roles.supervise` FIXED binding in the project then machine
 *      `agents.yaml` (`~/.roll/agents.yaml`) — the real config-driven source;
 *   3. honest empty — the collab board shows a blank supervisor rather than
 *      claiming an agent that was never configured (no silent fabrication).
 */
export function resolveSupervisorAgent(projectPath: string): string {
  const override = (process.env["ROLL_SUPERVISOR_AGENT"] ?? "").trim();
  if (override !== "") return override;
  const machinePath = join(process.env["ROLL_HOME"] ?? join(homedir(), ".roll"), "agents.yaml");
  const projectPathYaml = join(projectPath, ".roll", "agents.yaml");
  for (const p of [projectPathYaml, machinePath]) {
    const binding = readScopedAgentLayer(p)?.config.roles.supervise;
    if (binding?.kind === "fixed") return binding.agent;
  }
  return "";
}

function buildCollabEventSource(projectPath: string, events: readonly RollEvent[]): EventSource {
  return {
    readEvents: () => events,
    readSummary: (cycleId) => readCycleRoleSummary(projectPath, cycleId),
    rebuildSummary: (cycleId) => rebuildCycleRoleSummary(projectPath, events, cycleId),
    supervisor: () => resolveSupervisorAgent(projectPath),
    goalScope: () => collabGoalScope(projectPath),
  };
}

function buildSupervisorCollabStream(projectPath: string): CollabStreamView {
  const events = readSupervisorEvents(projectPath);
  return projectCollabStream(collabCycleIds(events), buildCollabEventSource(projectPath, events));
}

function fmtCollabLive(stream: CollabStreamView, noColor: boolean): string {
  return renderCollabStream(stream, { color: !noColor, fold: true, width: 72, lang: "en" }) + "\n";
}

function fmtCollabAppend(stream: CollabStreamView, noColor: boolean, fromCycleIndex: number): string {
  if (fromCycleIndex <= 0) return fmtCollabLive(stream, noColor);
  const delta: CollabStreamView = { ...stream, cycles: stream.cycles.slice(fromCycleIndex) };
  if (delta.cycles.length === 0) return "";
  return renderCollabStream(delta, { color: !noColor, fold: true, width: 72, lang: "en", header: false }) + "\n";
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envOptionalPositiveInt(name: string): number | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function followSupervisorCollabStream(projectPath: string, noColor: boolean): Promise<number> {
  const intervalMs = envPositiveInt("ROLL_SUPERVISOR_COLLAB_WATCH_INTERVAL_MS", 2_000);
  const tickLimit = envOptionalPositiveInt("ROLL_SUPERVISOR_COLLAB_WATCH_TICKS");
  let renderedCycles = 0;
  let ticks = 0;

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = (code: number): void => {
      if (timer !== undefined) clearInterval(timer);
      process.removeListener("SIGINT", onSigint);
      resolve(code);
    };
    const onSigint = (): void => stop(130);
    const tick = (): void => {
      ticks += 1;
      const stream = buildSupervisorCollabStream(projectPath);
      const out = fmtCollabAppend(stream, noColor, renderedCycles);
      if (out !== "") process.stdout.write(out);
      renderedCycles = stream.cycles.length;
      if (tickLimit !== undefined && ticks >= tickLimit) stop(0);
    };

    process.on("SIGINT", onSigint);
    tick();
    if (tickLimit !== undefined && ticks >= tickLimit) return;
    timer = setInterval(tick, intervalMs);
  });
}

function shortTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "n/a";
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function agentModel(agent: string, model: string): string {
  return model.trim() === "" ? agent : `${agent}/${model}`;
}

function fmtHealth(issues: ReturnType<typeof gatherAgentToolchainIssues>): string {
  if (issues.length === 0) return "\n  Agent toolchain health: clean\n\n";
  const rows = issues.map(
    (i) =>
      `    ${i.agent} · ${i.classification.replace(/_/g, "-")} · ${i.severity} · ` +
      `action=${i.action.replace(/_/g, "-")} · routing=${i.routing}` +
      `\n      detail: ${i.detail}\n      source: ${i.source}`,
  );
  return ["", "  Agent toolchain health", "", ...rows, ""].join("\n") + "\n";
}

function supervisorDeliveryRunBoard(projectPath: string, events: readonly RollEvent[]) {
  const audit = auditWorktrees({ repoRoot: projectPath, home: homedir() });
  return buildSupervisorDeliveryRunBoard(events, {
    now: Date.now(),
    staleAfterMs: SUPERVISOR_DELIVERY_STALE_AFTER_MS,
    inspections: audit.records.map((record) => ({
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      owner: record.owner,
      ...(record.storyId === undefined ? {} : { storyId: record.storyId }),
      relativeLocator: record.memberLocator ?? record.path,
      // `safe_to_release` is the worktree-audit adapter's existing all-member
      // proof: registered identity, inactive, expected head, and clean. Do not
      // widen its public JSON schema just to shuttle duplicated inspection data.
      registration: record.releaseVerdict === "safe_to_release" ? "registered" : record.repositoryIdentity === "foreign" ? "foreign" : record.registration ?? "unknown",
      activity: record.releaseVerdict === "safe_to_release" ? "inactive" : record.active ? "active" : "inactive",
      head: record.releaseVerdict === "safe_to_release" ? "expected" : "unknown",
      cleanliness: record.releaseVerdict === "safe_to_release" ? "clean" : record.dirtyTracked === "unknown" || record.dirtyUntracked === "unknown" ? "unknown" : "dirty",
    })),
  });
}

function fmtDeliveryRunBoard(board: ReturnType<typeof buildSupervisorDeliveryRunBoard>, lang: "en" | "zh"): string[] {
  const title = lang === "zh" ? "交付运行（共同 DeliveryRun 投影）" : "Delivery runs (shared DeliveryRun projection)";
  if (board.rows.length === 0) return ["", `    ${title}: ${lang === "zh" ? "暂无运行记录" : "no runs recorded"}`];
  const labels = lang === "zh"
    ? { members: "成员", reservation: "预留", delta: "增量", merge: "合并", evidence: "证据", recover: "恢复" }
    : { members: "members", reservation: "reservation", delta: "delta", merge: "merge", evidence: "evidence", recover: "recover" };
  const reason = (value: string): string => {
    if (lang !== "zh") return value;
    const zh: Record<string, string> = {
      "owner delivery required; handoff is not a merge or attest verdict": "等待负责人交付；交接不是合并或验收裁定",
      "managed workspace reserved; awaiting first activity": "已保留受管工作区；等待首次活动",
      "managed workspace activity is stale; inspect registration before recovery": "受管工作区活动已过期；恢复前请检查注册状态",
      "legacy protocol only; managed workspace facts are unavailable": "仅有旧协议记录；受管工作区事实不可用",
      "managed workspace facts are unavailable": "受管工作区事实不可用",
      "delivery merge truth is not confirmed": "交付合并事实尚未确认",
      "acceptance evidence truth is not confirmed": "验收证据事实尚未确认",
      "managed workspace is safe to release after owner confirmation": "受管工作区已满足安全释放条件，等待负责人确认",
      "release requested; await the managed release result": "已请求释放；等待受管释放结果",
      "delta protocol blocked; inspect its recorded block reason": "Delta 协议已阻塞；请检查记录的阻塞原因",
      "external workspace is unmanaged; inspect manually": "外部工作区未受管；请手动检查",
      "manual workspace is outside DeliveryRun protocol; inspect manually": "手动工作区不在 DeliveryRun 协议内；请手动检查",
    };
    return zh[value] ?? "详见 JSON 中的原始事件说明";
  };
  const value = (raw: string | null): string => {
    if (lang !== "zh" || raw === null) return raw ?? "?";
    const zh: Record<string, string> = {
      cycle: "周期", host_delta: "主机增量", external: "外部", active: "进行中", legacy: "旧协议",
      delivered_safe_to_release: "可安全释放", recovery_required: "需要恢复", handoff_ready: "已交接",
      unknown: "未知", active_unstarted: "已预留未开始", legacy_cycle: "旧周期", release_requested: "已请求释放",
      stale: "已过期", merged: "已合并", accepted: "已验收", handoff_only: "仅交接",
      delivery_team: "交付团队", "delta-team": "增量团队",
    };
    return zh[raw] ?? "未本地化状态";
  };
  const lines = ["", `    ${title}`];
  for (const row of board.rows) {
    const members = row.workspaceMembers.length === 0 ? "?" : row.workspaceMembers.join(",");
    lines.push(
      `    ${row.runId} · ${value(row.kind)} · ${lang === "zh" && row.storyId === "unknown" ? "未知" : row.storyId} · ${value(row.lifecycle)}`,
      `      ${labels.members}=${members} · ${labels.reservation}=${value(row.reservationState)} · ${labels.delta}=${value(row.deltaStatus)} · ${labels.merge}=${value(row.merge)} · ${labels.evidence}=${value(row.evidence)}`,
      `      ${labels.recover}: ${reason(row.recoveryReason)}`,
    );
  }
  return lines;
}

function fmtLiveZhValue(raw: string): string {
  const zh: Record<string, string> = {
    observing: "观察中", standard: "标准", verified: "已验证", designed: "已设计",
    active: "进行中", done: "已完成", failed: "失败", not_available: "不可用",
    pending: "待处理", working: "执行中", waiting: "等待中", not_required: "无需", ready: "就绪", blocked: "受阻",
    designer: "设计者", builder: "构建者", evaluator: "评估者",
    "standard: no execution profile event yet": "标准：尚无执行配置事件",
    "profile does not require design": "当前配置无需设计",
    "profile does not require independent evaluation": "当前配置无需独立评估",
    "design contract handed to builder": "设计契约已交给构建者",
    "cycle failed before builder handoff": "周期在交给构建者前失败",
    "building design contract": "正在编写设计契约",
    "cycle ended before builder completed": "周期在构建者完成前结束",
    "builder result available": "构建结果已就绪",
    "builder result handed to evaluator/publish": "构建结果已交给评估或发布",
    "executing story": "正在执行任务卡",
    "waiting for designer handoff": "正在等待设计者交接",
    "waiting to execute": "等待执行",
    "evaluator returned blocking findings": "评估者返回了阻塞性发现",
    "independent evaluation evidence available": "独立评估证据已就绪",
    "cycle failed before evaluation completed": "周期在评估完成前失败",
    "waiting for evaluator verdict": "正在等待评估结论",
    "waiting for builder result": "正在等待构建结果",
  };
  if (zh[raw] !== undefined) return zh[raw]!;
  const blockedBy = /^(.*?) blocked by (.*?)$/.exec(raw);
  if (blockedBy !== null) {
    const role = zh[blockedBy[1]!] ?? "相关环节";
    const cause = zh[blockedBy[2]!] ?? "未知原因";
    return `${role}因${cause}而受阻`;
  }
  return "详见 JSON 中的原始事件说明";
}

function fmtLiveZhSummary(board: ReturnType<typeof buildSupervisorLiveBoard>): string {
  const failures = board.supervisor.failureDistribution;
  const active = board.rows.filter((row) => row.status === "active" || row.status === "not_available").length;
  return `关注中的运行 ${active} 条，已渲染 ${board.rows.length} 条；失败：环境=${failures.env}、框架=${failures.harness}、任务卡=${failures.card}、未知=${failures.unknown}`;
}

function fmtLive(projectPath: string, title = "Supervisor Live — read-only role board", subtitle?: string): string {
  const events = readSupervisorEvents(projectPath);
  const board = buildSupervisorLiveBoard(events);
  const lang = resolveLang({ rollLang: process.env["ROLL_LANG"], lcAll: process.env["LC_ALL"], lang: process.env["LANG"] });
  const deliveryRuns = supervisorDeliveryRunBoard(projectPath, events);
  const liveTitle = lang !== "zh" ? title
    : title === "Supervisor Live — read-only role board" ? "监督实时面板 — 只读角色面板"
      : title === "Supervisor Live — watch" ? "监督实时面板 — 监看"
        : title;
  const liveSubtitle = lang === "zh" && subtitle !== undefined
    ? subtitle.replace(/^refresh every (.+) · Ctrl-C exits$/, "每 $1 刷新一次 · 使用 Ctrl-C 退出")
    : subtitle;
  const lines = ["", `  ${liveTitle}`];
  if (liveSubtitle !== undefined) lines.push(`  ${liveSubtitle}`);
  lines.push("", lang === "zh" ? `    监督状态：${fmtLiveZhValue(board.supervisor.state)} · ${fmtLiveZhSummary(board)}` : `    supervisor: ${board.supervisor.state} · ${board.supervisor.summary}`, "");
  if (board.rows.length === 0) {
    lines.push(lang === "zh" ? "    暂无周期运行记录" : "    no cycle rows yet", ...fmtDeliveryRunBoard(deliveryRuns, lang), "");
    return lines.join("\n") + "\n";
  }
  for (const row of board.rows) {
    if (lang === "zh") {
      lines.push(
        `    ${row.cycleId} · ${row.storyId} · ${fmtLiveZhValue(row.profile)} · ${fmtLiveZhValue(row.status)} · ${agentModel(row.agent, row.model)}`,
        `      更新时间 ${shortTs(row.updatedAt)} · ${fmtLiveZhValue(row.profileReason)}`,
      );
    } else {
      lines.push(
        `    ${row.cycleId} · ${row.storyId} · ${row.profile} · ${row.status} · ${agentModel(row.agent, row.model)}`,
        `      updated ${shortTs(row.updatedAt)} · ${row.profileReason}`,
      );
    }
    for (const role of row.roles) {
      const agent = role.agent === null ? "-" : role.agent;
      lines.push(lang === "zh"
        ? `      ${fmtLiveZhValue(role.role)} ${fmtLiveZhValue(role.state)} · 代理=${agent} · ${fmtLiveZhValue(role.reason)}`
        : `      ${role.role.padEnd(9)} ${role.state.padEnd(13)} agent=${agent} · ${role.reason}`);
    }
    lines.push(lang === "zh"
      ? `      交接 ${row.handoffs.map((h) => `${fmtLiveZhValue(h.from)}→${fmtLiveZhValue(h.to)}：${fmtLiveZhValue(h.state)}`).join(" · ")}`
      : `      handoff ${row.handoffs.map((h) => `${h.from}->${h.to}:${h.state}`).join(" · ")}`, "");
  }
  lines.push(...fmtDeliveryRunBoard(deliveryRuns, lang), "");
  return lines.join("\n") + "\n";
}

function formatIntervalSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

function parseSupervisorLiveWatchInterval(args: readonly string[]): { ok: true; intervalMs: number } | { ok: false; message: string } {
  const eq = args.find((a) => a.startsWith("--interval="));
  const raw = eq !== undefined ? eq.slice("--interval=".length) : argValue(args, "--interval");
  if (args.includes("--interval") && raw === undefined) {
    return { ok: false, message: "roll supervisor live --watch: --interval expects seconds, for example --interval 2\n" };
  }
  if (raw === undefined) return { ok: true, intervalMs: SUPERVISOR_LIVE_WATCH_DEFAULT_INTERVAL_MS };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, message: "roll supervisor live --watch: --interval expects seconds as a positive number\n" };
  }
  return { ok: true, intervalMs: Math.max(SUPERVISOR_LIVE_WATCH_MIN_INTERVAL_MS, Math.round(seconds * 1000)) };
}

function unknownSupervisorLiveFlag(args: readonly string[]): string | undefined {
  const allowed = new Set(["--watch", "--json", "--collab", "--once", "--no-color", "--interval"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "live") continue;
    if (args[i - 1] === "--interval") continue;
    if (arg.startsWith("--interval=")) continue;
    if (arg.startsWith("-") && !allowed.has(arg)) return arg;
  }
  return undefined;
}

function followSupervisorLiveBoard(projectPath: string, intervalMs: number): Promise<number> {
  const tickLimit = envOptionalPositiveInt("ROLL_SUPERVISOR_LIVE_WATCH_TICKS");
  let ticks = 0;

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const stop = (code: number): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      process.removeListener("SIGINT", onSigint);
      process.stdout.write("\x1b[?25h");
      resolve(code);
    };
    const onSigint = (): void => stop(130);
    const tick = (): void => {
      ticks += 1;
      process.stdout.write(
        "\x1b[2J\x1b[H" +
          fmtLive(projectPath, "Supervisor Live — watch", `refresh every ${formatIntervalSeconds(intervalMs)} · Ctrl-C exits`),
      );
      if (tickLimit !== undefined && ticks >= tickLimit) stop(0);
    };

    process.on("SIGINT", onSigint);
    process.stdout.write("\x1b[?25l");
    tick();
    if (tickLimit !== undefined && ticks >= tickLimit) return;
    timer = setInterval(tick, intervalMs);
  });
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value !== undefined && !value.startsWith("-") ? value : undefined;
}

function parseCastRole(raw: string | undefined): CastRoleName | null {
  if (raw === undefined || raw === "builder" || raw === "execute") return "builder";
  if (raw === "designer" || raw === "design") return "designer";
  if (raw === "evaluator" || raw === "evaluate" || raw === "score") return "evaluator";
  if (raw === "peer_reviewer" || raw === "peer-reviewer" || raw === "peer") return "peer_reviewer";
  return null;
}

export function supervisorCommand(args: string[]): number | Promise<number> {
  const json = args.includes("--json");
  const collab = args.includes("--collab");
  const once = args.includes("--once");
  const watch = args.includes("--watch");
  const noColor = args.includes("--no-color") || (process.env["NO_COLOR"] ?? "") !== "";
  let sub = args.find((a) => !a.startsWith("-"));
  // `status` is an alias for the default observe + advise summary.
  if (sub === "status") sub = undefined;
  if (sub !== undefined && !["observe", "advise", "next", "why", "live", "metrics", "journal", "health", "route", "repair-evidence"].includes(sub)) {
    process.stderr.write(supervisorUsage() + "\n");
    return 1;
  }
  const projectPath = process.cwd();
  if (sub === "metrics") return supervisorMetricsCommand(args, projectPath);
  if (sub === "journal") {
    return supervisorJournalCommand(args, projectPath);
  }
  if (sub === "route") {
    const role = parseCastRole(argValue(args, "--role"));
    if (role === null) {
      process.stderr.write("Usage: roll supervisor route --role builder|designer|evaluator|peer_reviewer [--story <id>] [--json]\n");
      return 1;
    }
    const route = resolveScopedCastRole(projectPath, role);
    if (route === null) {
      if (json) process.stdout.write(JSON.stringify({ role, scoped: false, story: argValue(args, "--story") ?? null }, null, 2) + "\n");
      else process.stdout.write(`\n  ${role} route\n  (no scoped agents.yaml; legacy tier routing in effect)\n\n`);
      return 0;
    }
    const trace = scopedExecuteRouteTrace(route);
    const story = argValue(args, "--story") ?? null;
    if (json) process.stdout.write(JSON.stringify({ ...trace, story }, null, 2) + "\n");
    else process.stdout.write(renderScopedExecuteRoute(trace));
    return 0;
  }
  if (sub === "repair-evidence") {
    // FIX-1058 — repair missing acceptance evidence for a green PR.
    // Takes a PR number, checks eligibility, records events, generates
    // ac-map draft + attest report, and records the repair as complete.
    const prArg = args.find((a) => /^\d+$/.test(a) && a !== "--json" && a !== "repair-evidence");
    if (prArg === undefined) {
      process.stderr.write("Usage: roll supervisor repair-evidence <pr-number>\n");
      return 1;
    }
    const prNumber = Number(prArg);

    // Gather PR state via gh CLI.
    const view = quietExecPort.run("gh", [
      "pr", "view", String(prNumber), "--json",
      "reviews,mergeStateStatus,statusCheckRollup,body,labels,isDraft,headRefName,state",
    ]);
    if (view.code !== 0) {
      process.stderr.write(`repair-evidence: cannot read PR #${prNumber} — gh pr view failed (code ${view.code})\n`);
      if (view.stdout !== "") process.stderr.write(view.stdout + "\n");
      return 1;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(view.stdout) as unknown;
    } catch {
      process.stderr.write(`repair-evidence: cannot parse gh pr view output for PR #${prNumber}\n`);
      return 1;
    }
    const reviews2: Array<{ authorAssociation?: string; state?: string }> = ((raw as { reviews?: unknown }).reviews ?? []) as Array<{ authorAssociation?: string; state?: string }>;
    const botReviews2 = reviews2.filter(
      (r) => r.authorAssociation === "BOT" || r.authorAssociation === "APP",
    );
    const lastBot2 = botReviews2.length > 0 ? botReviews2[botReviews2.length - 1] : undefined;
    const facts = {
      bot: lastBot2?.state ?? "",
      ciState: (() => {
        const rollup = ((raw as { statusCheckRollup?: StatusCheckRollupEntry[] }).statusCheckRollup ?? []);
        const state = reduceStatusCheckRollup(rollup);
        if (state === "green") return "success";
        if (state === "red") return "failure";
        return "";
      })(),
      mergeable: (raw as { mergeStateStatus?: string }).mergeStateStatus ?? "",
      manualMerge:
        ((raw as { body?: string }).body ?? "").includes("[roll:manual-merge]") ||
        ((raw as { labels?: Array<{ name?: string }> }).labels ?? []).some((label) => label.name === "manual-merge" || label.name === "roll:manual-merge"),
      isDraft: (raw as { isDraft?: boolean }).isDraft === true,
    };

    // Resolve story ID from PR.
    const events = readSupervisorEvents(projectPath);
    const alreadyRepaired = repairedPrNumbers(events).has(prNumber);
    let storyId = "";
    for (const ev of events) {
      if (ev.type === "pr:open" && ev.prNumber === prNumber) {
        storyId = ev.storyId;
        break;
      }
    }
    if (storyId === "") {
      const bodyStr = typeof (raw as { body?: unknown }).body === "string" ? ((raw as { body?: string }).body ?? "") : "";
      const headRef = typeof (raw as { headRefName?: unknown }).headRefName === "string" ? ((raw as { headRefName?: string }).headRefName ?? "") : "";
      storyId = extractStoryId([], headRef, bodyStr) ?? `PR-${prNumber}`;
    }

    // FIX-1061 — resolve the Roll evaluator score for this PR's cycle so a green
    // loop PR with an empty GitHub review can still be repaired on its real
    // Delta Team evaluator evidence.
    const headRefForCycle =
      typeof (raw as { headRefName?: unknown }).headRefName === "string"
        ? ((raw as { headRefName?: string }).headRefName ?? "")
        : "";
    const rollScore = resolveRollEvaluatorScore(projectPath, headRefForCycle, events);
    const approval = resolveEvaluatorApproval({ reviewState: facts.bot || "none", rollEvaluatorScore: rollScore });

    // Classify repair eligibility.
    const classification = classifyEvidenceRepair({
      ciState: facts.ciState || "unknown",
      reviewState: facts.bot || "none",
      mergeable: facts.mergeable || "unknown",
      isDraft: facts.isDraft === true,
      hasFreshReport: false, // We're asked to repair — assume no fresh report.
      alreadyRepaired,
      rollEvaluatorScore: rollScore,
    });

    if (classification.verdict === "already_repaired") {
      if (json) process.stdout.write(JSON.stringify({ prNumber, storyId, verdict: "already_repaired", reason: classification.reason }, null, 2) + "\n");
      else process.stdout.write(`\n  repair-evidence: PR #${prNumber} already repaired — no action needed\n  ${classification.reason}\n\n`);
      return 0;
    }
    if (classification.verdict !== "reparable") {
      if (json) process.stdout.write(JSON.stringify({ prNumber, storyId, verdict: classification.verdict, reason: classification.reason }, null, 2) + "\n");
      else process.stdout.write(`\n  repair-evidence: PR #${prNumber} is not reparable\n  ${classification.reason}\n\n`);
      return 1;
    }

    // Record repair_requested event.
    const eventsPath = join(projectPath, ".roll", "loop", "events.ndjson");
    const repairRequested: RollEvent = {
      type: "evidence:repair_requested",
      prNumber,
      storyId,
      reason: classification.reason,
      ts: Date.now(),
    };
    try {
      mkdirSync(dirname(eventsPath), { recursive: true });
      writeFileSync(eventsPath, JSON.stringify(repairRequested) + "\n", { flag: "a" });
    } catch (err: unknown) {
      process.stderr.write(`repair-evidence: cannot write events — ${String(err)}\n`);
      return 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Generate real ac-map + attest report artifacts before stamping
    // evidence:repaired. Per FIX-1058 spec AC2/AC3/AC4: the recovery path
    // must produce a non-empty acceptance report + ac-map visible at the
    // gate-checked `latest/` location, and the ac-map must pass the
    // attest gate's content predicate (positive ACs backed by real evidence
    // files — no bare-label placeholder text entries).
    // ═══════════════════════════════════════════════════════════════════

    // 1. Find the story card spec file.
    const featuresDir = join(projectPath, ".roll", "features");
    let specPath = "";
    let epic = "";
    if (existsSync(featuresDir)) {
      const entries = readdirSync(featuresDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(featuresDir, entry.name, storyId, "spec.md");
        if (existsSync(candidate)) {
          specPath = candidate;
          epic = entry.name;
          break;
        }
      }
    }

    // 2. Parse ACs from the spec file.
    let acItems: Array<{ id: string; text: string }> = [];
    if (specPath !== "") {
      try {
        const md = readFileSync(specPath, "utf8");
        acItems = acForStory(md, storyId);
      } catch {
        // Fall through — ac-items will be empty; the command still
        // succeeds (recording repair with empty ac-map) but warns.
      }
    }

    const storyDir = epic !== "" ? join(featuresDir, epic, storyId) : "";

    // 3. Write real evidence text files so the ac-map can reference them
    //    with `textFile` — the attest gate's content predicate
    //    (`acMapEvidenceIsReal`) requires a non-empty `textFile` for
    //    text-kind evidence; a bare label is an empty shell.
    const evidenceDir = storyDir !== "" ? join(storyDir, "evidence") : "";
    const repairSummaryFile = "repair-summary.txt";
    const repairSummaryRel = evidenceDir !== "" ? `evidence/${repairSummaryFile}` : repairSummaryFile;
    let repairSummaryAbs = "";
    if (evidenceDir !== "") {
      mkdirSync(evidenceDir, { recursive: true });
      repairSummaryAbs = join(evidenceDir, repairSummaryFile);
      const summaryLines = [
        `Repair evidence for ${storyId} — PR #${prNumber}`,
        `Generated: ${new Date().toISOString()}`,
        `CI state: ${facts.ciState || "unknown"}`,
        `Review state: ${facts.bot || "none"}`,
        `Mergeable: ${facts.mergeable || "unknown"}`,
        `Repair verdict: ${classification.verdict}`,
        `Evaluator source: ${approval.source} — ${approval.detail}`,
        `Classification reason: ${classification.reason}`,
        "",
        "Evidence-repair command completed. The PR was CI green + evaluator",
        "approved + merge clean but lacked a fresh acceptance report.",
        "This file records the repair fact; the ac-map.json and HTML report",
        "are the gate-visible acceptance artifacts.",
      ];
      writeFileSync(repairSummaryAbs, summaryLines.join("\n") + "\n", "utf8");
    }

    // 4. Build evidence refs that carry real `textFile` paths.
    const evidenceRefs: Array<{ kind: string; label: string; textFile: string }> = [];
    if (repairSummaryAbs !== "") {
      evidenceRefs.push({
        kind: "text",
        label: `repair-evidence summary: PR #${prNumber} CI=${facts.ciState} review=${facts.bot} merge=${facts.mergeable}`,
        textFile: repairSummaryRel,
      });
    }
    // CI state evidence (structural — counts as real per `acMapEvidenceIsReal`).
    if (facts.ciState === "success") {
      evidenceRefs.push({
        kind: "ci",
        label: `CI green on PR #${prNumber}`,
        textFile: repairSummaryRel,
      });
    }

    // 5. Generate ac-map with `readonly` status and real evidence refs
    //    so the attest gate's content predicate accepts the report.
    //    `readonly` is used (never `pass`) — the repair path documents
    //    existing CI/evaluator state; it does not re-verify the build.
    let acMapCount = 0;
    if (storyDir !== "" && acItems.length > 0) {
      const acMap = generateAcMap(storyId, acItems, {
        status: "readonly",
        evidenceRefs,
        fallbackTextFile: repairSummaryRel,
      });
      const acMapPath = join(storyDir, "ac-map.json");
      writeFileSync(acMapPath, JSON.stringify(acMap, null, 2) + "\n", "utf8");
      acMapCount = acItems.length;
    }

    // 6. Generate an HTML Acceptance Review Page at the gate-checked location.
    //    The attest gate's `existingReport()` looks for:
    //      features/<epic>/<ID>/latest/<ID>-report.html  (primary)
    //    We use `renderReport` — the same pure renderer normal delivery
    //    uses — so the report is structured identically.
    let htmlReportPath = "";
    if (storyDir !== "" && acItems.length > 0) {
      const now = new Date();
      const items = acItems.map((ac) => ({
        id: ac.id,
        text: ac.text,
        status: "readonly" as const,
        evidence: evidenceRefs.map((ref) => ({
          kind: ref.kind as "text" | "ci",
          label: ref.label,
          href: ref.textFile,
        })),
      }));
      const html = renderReport({
        storyId,
        title: `${storyId} — Acceptance Review Page (repaired)`,
        generatedAt: now.toISOString(),
        items,
        facts: { tcrCount: 0, ciConclusion: facts.ciState || "unknown", testPassAge: "repaired (post-hoc)" },
        evidenceDeltaSummary: `Evidence repaired via \`roll supervisor repair-evidence\` for PR #${prNumber}. CI=${facts.ciState}, review=${facts.bot}, merge=${facts.mergeable}.`,
      });
      const latestDir = join(storyDir, "latest");
      mkdirSync(latestDir, { recursive: true });
      writeFileSync(join(latestDir, reviewFileName(storyId)), html, "utf8");
      htmlReportPath = join(latestDir, reportFileName(storyId));
      writeFileSync(htmlReportPath, html, "utf8");
    }

    // 7. Record the repair as complete ONLY after real artifacts exist.
    const repaired: RollEvent = {
      type: "evidence:repaired",
      prNumber,
      storyId,
      outcome: "evidence-generated",
      details: [
        `acceptance evidence repaired for ${storyId}`,
        acMapCount > 0 ? `ac-map: ${acMapCount} AC(s) at readonly with real evidence refs` : "ac-map: (no ACs found)",
        htmlReportPath !== "" ? `report: ${htmlReportPath}` : "report: (skipped — no ACs)",
        `CI: ${facts.ciState} | evaluator: ${approval.source} (${approval.detail}) | merge: ${facts.mergeable}`,
      ].join("; "),
      ts: Date.now(),
    };
    try {
      writeFileSync(eventsPath, JSON.stringify(repaired) + "\n", { flag: "a" });
    } catch (err: unknown) {
      process.stderr.write(`repair-evidence: cannot write repaired event — ${String(err)}\n`);
      return 1;
    }

    if (json) {
      process.stdout.write(JSON.stringify({
        prNumber,
        storyId,
        verdict: "repaired",
        action: "merge_ready",
        evaluatorSource: approval.source,
        evaluatorDetail: approval.detail,
        reason: classification.reason,
        artifacts: {
          acMap: acMapCount > 0 ? `${storyId}/ac-map.json` : null,
          report: htmlReportPath || null,
          acCount: acMapCount,
          evidenceFiles: evidenceRefs.map((r) => r.textFile),
        },
      }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `\n  repair-evidence: PR #${prNumber} (${storyId}) repaired\n` +
        `  action: merge_ready — the PR can now be promoted (if draft) and merged\n` +
        `  evaluator: ${approval.source} — ${approval.detail}\n` +
        `  ac-map: ${acMapCount > 0 ? `generated for ${acMapCount} AC(s) at readonly status in ${storyId}/ac-map.json` : "(no ACs found — check spec.md)"}\n` +
        `  report: ${htmlReportPath || "(skipped — no ACs)"}\n` +
        `  evidence: ${repairSummaryAbs || "(skipped)"}\n` +
        `  ${classification.reason}\n\n`,
      );
    }
    return 0;
  }

  if (sub === "live") {
    const unknownFlag = unknownSupervisorLiveFlag(args);
    if (unknownFlag !== undefined) {
      process.stderr.write(`roll supervisor live: unknown flag for roll supervisor live: ${unknownFlag}\n${supervisorUsage()}\n`);
      return 1;
    }
    if (watch && json) {
      process.stderr.write("roll supervisor live --watch: cannot combine --watch with --json; use snapshot JSON without --watch\n");
      return 1;
    }
    if (watch && collab) {
      process.stderr.write("roll supervisor live --watch: --collab already follows the collaboration stream; omit --watch\n");
      return 1;
    }
    if (!watch && (args.includes("--interval") || args.some((a) => a.startsWith("--interval=")))) {
      process.stderr.write("roll supervisor live: --interval only applies with --watch\n");
      return 1;
    }
    if (collab) {
      const stream = buildSupervisorCollabStream(projectPath);
      if (json) process.stdout.write(JSON.stringify(stream, null, 2) + "\n");
      else if (once) process.stdout.write(fmtCollabLive(stream, noColor));
      else return followSupervisorCollabStream(projectPath, noColor);
    } else {
      if (watch) {
        const parsed = parseSupervisorLiveWatchInterval(args);
        if (!parsed.ok) {
          process.stderr.write(parsed.message);
          return 1;
        }
        if ((process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY !== true) {
          process.stderr.write("roll supervisor live --watch requires an interactive terminal; use `roll supervisor live` for a snapshot in pipes/CI\n");
          return 1;
        }
        return followSupervisorLiveBoard(projectPath, parsed.intervalMs);
      }
      const events = readSupervisorEvents(projectPath);
      const board = buildSupervisorLiveBoard(events);
      if (json) process.stdout.write(JSON.stringify({ ...board, deliveryRuns: supervisorDeliveryRunBoard(projectPath, events) }, null, 2) + "\n");
      else process.stdout.write(fmtLive(projectPath));
    }
    return 0;
  }
  if (sub === "health") {
    const events = readSupervisorEvents(projectPath);
    const issues = gatherAgentToolchainIssues(events);
    if (json) {
      process.stdout.write(JSON.stringify({ issues, summary: summarizeAgentHealthIssues(issues) }, null, 2) + "\n");
    } else {
      process.stdout.write(fmtHealth(issues));
    }
    return 0;
  }
  const input = gatherSupervisorInput(projectPath);
  const facts = observeProject(input);

  if (json) {
    const mode = resolveOperatingMode(projectPath);
    const events = readSupervisorEvents(projectPath);
    const runbook = buildSupervisorRunbookState(input);
    const compactRunbook = compactRunbookForJson(runbook);
    const ctx = supervisorContext(projectPath, input, events);
    const compactCtx = compactContextForJson(ctx);
    const out =
      sub === "advise"
        ? { mode, decisions: supervisorDecisions(input), runbook, ...ctx }
        : sub === "next"
          ? { mode, next: runbook.next, runbook: compactRunbook, ...compactCtx }
          : sub === "why"
            ? { mode, why: runbookWhy(runbook, facts), noProgressRecovery: readNoProgressStall(projectPath, events) ?? null, runbook: compactRunbook, ...compactCtx }
            : { mode, facts, decisions: supervisorDecisions(input), next: runbook.next, runbook, ...ctx };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }

  if (sub === "observe") {
    process.stdout.write(fmtFacts(input, readSupervisorEvents(projectPath)));
    return 0;
  }
  if (sub === "advise") {
    process.stdout.write(fmtAdvice(input));
    return 0;
  }
  if (sub === "next") {
    const state = buildSupervisorRunbookState(input);
    const n = recommendNext(input);
    const mode = resolveOperatingMode(projectPath);
    const ctx = supervisorContext(projectPath, input, readSupervisorEvents(projectPath));
    // US-LOOP-112: this used to branch on `mode.mode === "guided"` to decide
    // between suggesting an explicit run command and deferring to the scheduler's
    // own next action. There is no scheduler and no second mode — a card that is
    // ready to run is always run by this session, so always name the command.
    const action = state.next.kind === "run_card" ? suggestedGuidedRun(n.storyId) : state.next.ownerAction;
    const browserLines = renderBrowserTruthSupervisorLine(collectBrowserTruth({ projectPath }));
    process.stdout.write(
      `\n  Supervisor — next: ${n.storyId ?? "(nothing ready)"}\n  scope: ${state.scope.label}\n  remaining: ${remainingLine(input)}\n  cast: ${ctx.cast}\n  cast detail: ${ctx.castDetail}\n  gate: ${ctx.gate}\n  manual merge: ${ctx.manualMerge}\n  semantic ranking: ${ctx.pickRanking?.line ?? "none"}\n  .roll meta: ${ctx.rollMeta.state} — ${ctx.rollMeta.detail}\n  agent health: ${state.agentHealth.summary}\n${browserLines.join("\n")}\n\n  ${n.reason}\n  ${formatOperatingMode(mode)}\n  owner action: ${action}\n  scheduler: ${state.next.schedulerAction}\n\n`,
    );
    return 0;
  }
  if (sub === "why") {
    const mode = resolveOperatingMode(projectPath);
    const state = buildSupervisorRunbookState(input);
    const why = runbookWhy(state, facts);
    const events = readSupervisorEvents(projectPath);
    const ctx = supervisorContext(projectPath, input, events);
    const stall = readNoProgressStall(projectPath, events);
    const ownerAction = state.next.kind === "diagnose_failure" || state.next.kind === "manual_merge_gate" ? state.next.ownerAction : mode.ownerAction;
    const schedulerAction =
      state.next.kind === "diagnose_failure" || state.next.kind === "manual_merge_gate" ? state.next.schedulerAction : mode.schedulerAction;
    const recoveryBlock = stall !== undefined ? `\n${fmtNoProgressRecovery(stall)}` : "";
    process.stdout.write(
      `\n  Supervisor — why stuck: ${why}\n  cast: ${ctx.cast}\n  cast detail: ${ctx.castDetail}\n  gate: ${ctx.gate}\n  manual merge: ${ctx.manualMerge}\n  .roll meta: ${ctx.rollMeta.state} — ${ctx.rollMeta.detail}\n  agent health: ${state.agentHealth.summary}${recoveryBlock}\n  ${formatOperatingMode(mode)}\n  owner action: ${ownerAction}\n  scheduler: ${schedulerAction}\n\n`,
    );
    return 0;
  }
  // default: observe + advise
  process.stdout.write(fmtFacts(input, readSupervisorEvents(projectPath)) + fmtAdvice(input));
  return 0;
}
