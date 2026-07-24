/**
 * `roll design` — explicit thin entry point for the `$roll-design` skill
 * (US-ONBOARD-NUDGE-004, FIX-1055).
 *
 * Deterministically selects an interactive agent, loads the roll-design skill
 * prompt, and launches the conversation. The command now captures the agent's
 * raw output to a per-run transcript, renders a bounded progress view, and
 * prints a final artifact handoff so the operator knows what changed, where
 * the design lives, and what to do next.
 */
import { spawn as spawnChild, type SpawnOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { REQUIREMENT_HINT_V1, classifyStatus, t, v2Catalog, v3Catalog, type Lang, type RequirementHintV1, type WorkspaceContextOperationProvenance, type WorkspaceContextScope, type WorkspaceExecutionContextV1 } from "@roll/spec";
import { authorizesLegacyWorkspaceContextOperation, normalizerFor, newNormalizerState, parseBacklog, type ActivitySignal } from "@roll/core";
import { currentLang } from "./agent-list.js";
import { loopGoCommand } from "./loop-go.js";
import {
  agentEnvFromEnv,
  discoverInteractiveAgents,
  interactiveAgentCommand,
  readLineFromStdin,
  readPrimaryAgent,
  readSkillBody,
} from "../lib/interactive-agent.js";
import { renderDesignReviewPageFromMarkdown } from "../lib/review-page.js";
import { projectBacklogPath, projectDataPath, projectDataRoot, projectRuntimePath } from "../lib/archive.js";
import { readRigLifecycleState } from "../runner/agent-liveness.js";
import { workspaceExecutionEnvironment } from "../runner/agent-spawn.js";
import { prepareWorkspaceSkillHandoff } from "../runner/workspace-skill-handoff.js";

function lang(): Lang {
  return currentLang();
}

function emit(line: string): void {
  process.stderr.write(`${line}\n`);
}

function readDesignPrompt(fromFile: string | undefined, rest: string[]): string | null {
  const body = readSkillBody("roll-design");
  if (body === null) return null;
  const parts: string[] = [];
  if (fromFile !== undefined) {
    parts.push(
      `The user invoked \`roll design --from-file ${fromFile}\`.`,
      `Use this product brief file as the design input: ${fromFile}`,
      "Read it before asking broad discovery questions, then run the $roll-design workflow.",
    );
  }
  const req = rest.join(" ").trim();
  if (req !== "") {
    parts.push(
      `The user invoked \`roll design ${req}\`.`,
      `Design requirement: ${req}`,
    );
  }
  const handoff = parts.length > 0 ? parts.join("\n") + "\n\n" : "";
  return `${handoff}Run the $roll-design skill below for this project. Follow it end-to-end.\n\n${body}`;
}

interface ParsedDesignFlags {
  agent: string | undefined;
  fromFile: string | undefined;
  verbose: boolean;
  raw: boolean;
  rest: string[];
  error: "from_file_missing" | null;
}

function parseDesignFlags(args: string[]): ParsedDesignFlags {
  const rest: string[] = [];
  let agent: string | undefined;
  let fromFile: string | undefined;
  let verbose = false;
  let raw = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "--agent") {
      agent = args[i + 1];
      i += 1;
    } else if (a.startsWith("--agent=")) {
      agent = a.slice("--agent=".length);
    } else if (a === "--from-file") {
      const value = args[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        return { agent, fromFile, verbose, raw, rest, error: "from_file_missing" };
      }
      fromFile = value;
      i += 1;
    } else if (a.startsWith("--from-file=")) {
      const value = a.slice("--from-file=".length);
      if (value === "") return { agent, fromFile, verbose, raw, rest, error: "from_file_missing" };
      fromFile = value;
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    } else if (a === "--raw") {
      raw = true;
    } else {
      rest.push(a);
    }
  }
  return { agent, fromFile, verbose, raw, rest, error: null };
}

/** Deterministic structured identities only; prose inference stays out of the host. */
export function designRequirementHint(args: string[], invocationCwd = process.cwd()): RequirementHintV1 {
  const parsed = parseDesignFlags(args);
  const fromFilePath = parsed.fromFile === undefined ? undefined : resolve(invocationCwd, parsed.fromFile);
  let fromFileText = "";
  if (fromFilePath !== undefined && isRegularFile(fromFilePath)) {
    try {
      fromFileText = readFileSync(fromFilePath, "utf8");
    } catch {
      fromFileText = "";
    }
  }
  const text = `${parsed.rest.join(" ")}\n${fromFileText}`;
  const storyIds = [...new Set(text.match(/\b(?:US|FIX|REFACTOR|IDEA|BUG)(?:-[A-Z0-9]+)+[a-z]?\d*\b/gu) ?? [])];
  const storySet = new Set(storyIds);
  const jiraRefs = [...new Set(text.match(/\b[A-Z][A-Z0-9]+-[0-9]+\b/gu) ?? [])]
    .filter((ref) => !storySet.has(ref));
  return {
    schema: REQUIREMENT_HINT_V1,
    sources: jiraRefs.map((ref) => ({
      key: { provider: "jira" as const, ref },
      provenance: "deterministic_extraction" as const,
    })),
    storyIds: storyIds.map((storyId) => ({
      storyId,
      provenance: "deterministic_extraction" as const,
    })),
    repositoryRemotes: [],
    paths: fromFilePath === undefined || !isRegularFile(fromFilePath)
      ? []
      : [{ path: fromFilePath, provenance: "cli_argument" as const }],
  };
}

function isRollProject(cwd: string): boolean {
  const root = projectDataRoot(cwd);
  return root === cwd
    ? existsSync(projectBacklogPath(cwd)) && existsSync(projectDataPath(cwd, "features"))
    : existsSync(root);
}

function authorityBacklog(cwd: string, context: WorkspaceExecutionContextV1 | undefined): string {
  return context?.authorities.backlog ?? projectBacklogPath(cwd);
}

function authorityPath(
  cwd: string,
  context: WorkspaceExecutionContextV1 | undefined,
  authority: "features" | "runtime",
  ...segments: string[]
): string {
  if (context !== undefined) return join(context.authorities[authority], ...segments);
  return authority === "features"
    ? projectDataPath(cwd, "features", ...segments)
    : projectRuntimePath(cwd, ...segments);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `.roll/backlog.md` has at least one Todo card row. */
function hasTodoBacklog(cwd: string, context?: WorkspaceExecutionContextV1): boolean {
  const bp = authorityBacklog(cwd, context);
  try {
    const content = readFileSync(bp, "utf8");
    return parseBacklog(content).some((row) => classifyStatus(row.status) === "todo");
  } catch {
    return false;
  }
}

export interface DesignSpawnResult {
  status: number | null;
  signal: string | null;
  stdout?: string;
  stderr?: string;
}

export interface DesignSpawnLive {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

export interface DesignCommandDeps {
  /** Current working directory for project checks. */
  cwd: string;
  /** Original invocation cwd; input files resolve here, not against Workspace authority. */
  invocationCwd: string;
  /** Frozen host-resolved authority for Workspace-native production runs. */
  workspaceExecution?: WorkspaceExecutionContextV1;
  /** Missing context is allowed only for an explicitly classified legacy migration. */
  workspaceContextScope: WorkspaceContextScope;
  /** Operation-level proof for the legacy migration exception. */
  workspaceContextOperationProvenance?: WorkspaceContextOperationProvenance;
  /** Environment variables (used for `ROLL_DESIGN_AGENT`). */
  env: NodeJS.ProcessEnv;
  /** Read one interactive selection line. */
  readLine: () => string | null;
  /** Spawn the selected agent. */
  spawn: (bin: string, args: string[], opts: SpawnOptions, live?: DesignSpawnLive) => DesignSpawnResult | Promise<DesignSpawnResult>;
  /** Start the autonomous loop after owner confirmation. */
  runLoopGo: (args: string[]) => number | Promise<number>;
  /** Wall-clock epoch ms provider (used for timestamps and run folder naming). */
  now: () => number;
  /** Quiet interval before a live heartbeat is emitted. */
  heartbeatMs: number;
}

const INIT_ONBOARD_DESIGN_AUTHORITY = Symbol("roll.init.onboard.design");

interface LegacyWorkspaceSkillHandoffV1 {
  readonly schemaVersion: 1;
  readonly scope: "legacy_migration_only";
  readonly operation: WorkspaceContextOperationProvenance;
}

function prepareLegacyWorkspaceSkillHandoff(input: {
  readonly skillName: string;
  readonly operation: WorkspaceContextOperationProvenance;
  readonly skillBody: string;
}): { readonly skillBody: string; readonly handoffJson: string } {
  const handoff: LegacyWorkspaceSkillHandoffV1 = {
    schemaVersion: 1,
    scope: "legacy_migration_only",
    operation: input.operation,
  };
  const handoffJson = JSON.stringify(handoff);
  const block = [
    "[Roll Workspace legacy skill handoff]",
    `skill: ${input.skillName}`,
    "scope: legacy_migration_only",
    `operation: ${JSON.stringify(input.operation)}`,
    "This run is an explicitly authorized legacy migration input; no canonical Workspace authority exists yet.",
    "Use the selected legacy project only as onboarding input, then produce a canonical Workspace next action without dual-writing authority.",
    `handoff-json: ${handoffJson}`,
    "[/Roll Workspace legacy skill handoff]",
  ].join("\n");
  return { skillBody: `${block}\n\n${input.skillBody}`, handoffJson };
}

function formatRunFolder(ts: number, target: string | null): string {
  const d = new Date(ts);
  const iso = d.toISOString();
  // 2026-06-30T23-10-00Z
  const stamp = `${iso.slice(0, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}Z`;
  const slug = (target ?? "design").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "design";
  return `${stamp}-${slug}`;
}

function transcriptPath(cwd: string, ts: number, target: string | null, context?: WorkspaceExecutionContextV1): string {
  if (context !== undefined) {
    return authorityPath(cwd, context, "runtime", "design", formatRunFolder(ts, target), "transcript.log");
  }
  return projectDataRoot(cwd) === cwd
    ? projectRuntimePath(cwd, "design", formatRunFolder(ts, target), "transcript.log")
    : projectDataPath(cwd, "runs", "design", formatRunFolder(ts, target), "transcript.log");
}

function lookupEpic(target: string, cwd: string, context?: WorkspaceExecutionContextV1): string | null {
  try {
    const indexPath = context === undefined
      ? projectDataPath(cwd, "index.json")
      : join(context.workspace.canonicalRoot, "index.json");
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as { stories?: Record<string, string> };
    return parsed.stories?.[target] ?? null;
  } catch {
    return null;
  }
}

function readBacklogItems(cwd: string, context?: WorkspaceExecutionContextV1): { id: string; desc: string; status: string }[] {
  try {
    const content = readFileSync(authorityBacklog(cwd, context), "utf8");
    return parseBacklog(content).map((row) => ({ id: row.id, desc: row.desc, status: row.status }));
  } catch {
    return [];
  }
}

function hasDetailedDesign(path: string): boolean {
  try {
    return /#\s*Detailed design/i.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function isIdeaTarget(target: string | null): boolean {
  return target !== null && /^IDEA-/i.test(target);
}

function renderDesignReviewPageForTarget(ctx: RunContext, cardsCreated: number): void {
  if (ctx.target === null || ctx.fromFile !== undefined) return;
  const epic = lookupEpic(ctx.target, ctx.cwd, ctx.workspaceExecution);
  if (epic === null) return;
  const base = relative(ctx.cwd, authorityPath(ctx.cwd, ctx.workspaceExecution, "features", epic, ctx.target));
  const md = join(base, "spec.md");
  const absMd = resolve(ctx.cwd, md);
  if (!existsSync(absMd) || !hasDetailedDesign(absMd)) return;
  const markdown = readFileSync(absMd, "utf8");
  const html = renderDesignReviewPageFromMarkdown({
    id: ctx.target,
    title: ctx.target,
    sourceSpecPath: md,
    status: cardsCreated > 0 ? "cards-created" : isIdeaTarget(ctx.target) ? "awaiting-signoff" : "draft",
    generatedAt: new Date(ctx.startTs).toISOString(),
    cardsCreated,
    nextAction: cardsCreated > 0
      ? t(v3Catalog, ctx.lang, "design.next.cards_created")
      : isIdeaTarget(ctx.target)
        ? t(v3Catalog, ctx.lang, "design.next.review_and_split", ctx.target)
        : t(v3Catalog, ctx.lang, "design.next.no_cards", ctx.target),
    markdown,
    lang: ctx.lang,
  });
  const out = resolve(ctx.cwd, base, "design-review.html");
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, html, "utf8");
  renameSync(tmp, out);
}

function isQuestionLike(summary: string): boolean {
  return /[?？]/.test(summary);
}

function fmtHhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatSignal(sig: ActivitySignal): string {
  const detail = sig.detail !== undefined && sig.detail !== "" ? `  ${sig.detail}` : "";
  return `${fmtHhmmss(sig.ts)}  ${sig.summary}${detail}`.trimEnd();
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * Structural noise denylist (FIX-1076). A generic-agent design run streams every
 * raw stdout line as a tier-C `say`, so the skill prompt, template examples,
 * echoed diffs, and raw peer-review shell all reach the view. We hide anything
 * that is NOT this run's real progress by its SHAPE (diff / code / markdown /
 * box-drawing / shell / template placeholder), not by design vocabulary — a diff
 * path like `.roll/domain/context-map.md` contains "context" and would otherwise
 * pass the keyword allowlist. The full stream still lands in transcript.log.
 */
function isDesignNoise(text: string): boolean {
  const s = text.trim();
  if (s === "") return true;
  if (/^\?\?\s/.test(s)) return true; // git status porcelain
  if (/^\s*-\s*\[\s*\]\s+/.test(s)) return true; // checklist echo
  if (/\$roll-design|roll-design contract|ID generation algorithm|Who writes the data|encrypted reasoning/i.test(s)) {
    return true;
  }

  // Echoed diff / patch / raw code fragments (the ×12 context-map.md diff).
  if (/^(diff --git |index [0-9a-f]{4,}|\+\+\+ |--- |@@ |[+-]{1,3}\s)/.test(s)) return true;
  if (/^[+-]\s*\S/.test(s)) return true; // any leading +/- diff body line
  if (/^\s*(export |import |function |const |let |return |run\()/.test(s)) return true; // code
  if (/^\s*[A-Za-z_]\w*\??:\s.*[;,]?\s*$/.test(s) && /[;{}]|"|\?:/.test(s)) return true; // TS members

  // Echoed skill prompt / spec markdown structure.
  if (/^#{1,6}\s/.test(s)) return true; // markdown headers
  if (/^>\s?/.test(s)) return true; // blockquotes
  if (/^\s*\|.*\|\s*$/.test(s)) return true; // table rows
  if (/[│├└┌┐┘─]/.test(s)) return true; // box-drawing skill diagrams
  if (/[│｜]\s*→|→\s*\[|└──|├──/.test(s)) return true; // flow arrows in skill diagrams

  // Template placeholders — never a real card / real content.
  if (/\{[A-Z]{2,}\}|\{YYYY|\{N\}|\{one-line|\{EventName|\{Bounded|\{consumer|\{if /.test(s)) return true;
  if (/<story>|<epic>|<context>|<path>|US-\{|features\/<epic>/.test(s)) return true;

  // Skill hub / gate / contract instruction lines (static, not this run).
  // NOTE: deliberately does NOT match bare "Bounded Context" / "Context Map" —
  // those are legitimate design-progress vocabulary; their echoed forms are
  // caught structurally above (markdown headers, table rows, box diagrams).
  if (/(routing boundary|hard gates|engineering checklist|Keep this hub|Evaluation contract|Visual-evidence contract|Backlog Structure|Event Storming|Tactical Model|Ubiquitous Language)/i.test(s)) {
    return true;
  }

  // Template DDD teaching example from another domain (e-commerce), not intel-radar.
  if (/(Order Context|Inventory Context|Payment Context|OrderPlaced|OrderShipped|OrderCancelled|InventoryReserved|PaymentCompleted|PaymentFailed)/.test(s)) {
    return true;
  }
  if (/支付失败|库存预留|扣减策略|回滚库存|买家提交/.test(s)) return true;

  // Raw shell / tool invocation echo (peer review is re-emitted as one event line).
  if (/^\/bin\/(zsh|bash|sh)\b/.test(s)) return true;
  if (/\[PEER_REVIEW\b/.test(s)) return true;
  if (/--no-session|--no-context-files|--tools\s/.test(s)) return true;
  if (/\b(claude|kimi|pi|codex)\b[^\n]*\s-p\b/.test(s)) return true;
  if (/\bsed -n\b|\bcat\b.*\|/.test(s)) return true;
  if (/\sin\s\/.+\[.*\]$/.test(s)) return true; // "<cmd> in /path[branch]" transcript echo

  return false;
}

/**
 * If a raw line announces a peer-review invocation, synthesize a single
 * structured event line (`peer review · A → B`); otherwise null. The renderer
 * dedups these so three back-to-back invocations collapse to distinct edges only.
 */
function peerReviewEvent(text: string): string | null {
  const m = /tool=(\w+)\s*(?:→|->|=>)\s*(\w+)/.exec(text);
  if (m === null) return null;
  return `peer review · ${m[1]} → ${m[2]}`;
}

function isMeaningfulDesignSay(summary: string): boolean {
  return /\b(reading|planning|designing|writing|validating|recovering|handoff|backlog|spec|artifact|context|contexts|created|card)\b/i.test(summary);
}

function shouldShowSignal(sig: ActivitySignal, verbose: boolean): boolean {
  const joined = `${sig.summary} ${sig.detail ?? ""}`;
  if (isDesignNoise(joined)) return false;
  if (verbose) return true;
  if (sig.tier === "A" || sig.tier === "B") return true;
  if (sig.kind === "say" && isMeaningfulDesignSay(sig.summary)) return true;
  return sig.kind === "say" && isQuestionLike(sig.summary);
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function transcriptSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function splitCardDescription(desc: string): { title: string; problem: string } {
  const clean = desc.replace(/\s+/g, " ").trim();
  const solves = /\s+·\s+solves\s+/i.exec(clean);
  if (solves !== null) {
    const title = clean.slice(0, solves.index).trim();
    const problem = clean.slice(solves.index + solves[0].length).trim();
    return { title: title || clean, problem: problem || title || clean };
  }
  return { title: clean || "Untitled card", problem: clean || "the design gap" };
}

interface LiveProgress {
  readonly sawLiveOutput: boolean;
  readonly rawTranscript: string;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
  ingestStdout: (chunk: string) => void;
  ingestStderr: (chunk: string) => void;
  flush: () => void;
}

function createLiveProgress(ctx: RunContext, deps: DesignCommandDeps, opts: { raw: boolean; verbose: boolean }): LiveProgress {
  const normalizer = normalizerFor(ctx.agent);
  const state = newNormalizerState();
  const emittedCards = new Set<string>();
  const knownBefore = new Set(ctx.beforeBacklog.map((row) => row.id));
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let rawTranscript = "";
  let sawLiveOutput = false;
  let lastPrintedTs = ctx.startTs;
  let heartbeat: NodeJS.Timeout | undefined;
  // FIX-1076: dedup already-shown view lines (kills the ×12 repeated diff and
  // any re-emitted identical signal). Keyed on the visible body, timestamp-free.
  const emittedLines = new Set<string>();

  const emitOnce = (ts: number, body: string): void => {
    if (opts.verbose) {
      lastPrintedTs = ts;
      emit(`${fmtHhmmss(ts)}  ${body}`);
      return;
    }
    if (emittedLines.has(body)) return;
    emittedLines.add(body);
    lastPrintedTs = ts;
    emit(`${fmtHhmmss(ts)}  ${body}`);
  };

  const scanCards = (): void => {
    if (opts.raw) return;
    for (const item of readBacklogItems(ctx.cwd, ctx.workspaceExecution)) {
      if (knownBefore.has(item.id) || emittedCards.has(item.id)) continue;
      emittedCards.add(item.id);
      const { title, problem } = splitCardDescription(item.desc);
      const ts = deps.now();
      lastPrintedTs = ts;
      emit(`${fmtHhmmss(ts)}  card created: ${item.id} — ${title} · solves ${problem}`);
    }
  };

  const processLine = (line: string): void => {
    if (opts.raw) return;
    const ts = deps.now();
    // FIX-1076: a peer-review invocation echoes as raw shell; surface it as one
    // structured event instead of the raw command line.
    const peer = peerReviewEvent(line);
    if (peer !== null) {
      emitOnce(ts, peer);
      return;
    }
    const signals = normalizer.normalize(line, state, ts);
    for (const sig of signals) {
      if (!shouldShowSignal(sig, opts.verbose)) continue;
      const body = formatSignal(sig).replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
      emitOnce(sig.ts, body);
    }
  };

  const ingest = (chunk: string, stream: "stdout" | "stderr"): void => {
    if (chunk === "") return;
    sawLiveOutput = true;
    rawTranscript += chunk;
    appendFileSync(ctx.transcriptPath, chunk, "utf8");
    if (opts.raw) {
      process.stderr.write(chunk);
      return;
    }
    const next = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + chunk;
    const parts = next.split(/\n/);
    const complete = parts.slice(0, -1);
    for (const line of complete) processLine(line);
    if (stream === "stdout") stdoutBuffer = parts[parts.length - 1] ?? "";
    else stderrBuffer = parts[parts.length - 1] ?? "";
    scanCards();
  };

  const emitHeartbeat = (): void => {
    if (opts.raw) return;
    const ts = deps.now();
    if (ts - lastPrintedTs < deps.heartbeatMs) return;
    lastPrintedTs = ts;
    emit(
      `${fmtHhmmss(ts)}  heartbeat: still designing · elapsed ${formatDuration(ts - ctx.startTs)} · ` +
        `transcript ${formatBytes(transcriptSize(ctx.transcriptPath))} · cards observed ${emittedCards.size}`,
    );
  };

  return {
    get sawLiveOutput() {
      return sawLiveOutput;
    },
    get rawTranscript() {
      return rawTranscript;
    },
    startHeartbeat: () => {
      if (opts.raw) return;
      heartbeat = setInterval(emitHeartbeat, deps.heartbeatMs);
      heartbeat.unref?.();
    },
    stopHeartbeat: () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    },
    ingestStdout: (chunk) => ingest(chunk, "stdout"),
    ingestStderr: (chunk) => ingest(chunk, "stderr"),
    flush: () => {
      if (stdoutBuffer !== "") {
        processLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      if (stderrBuffer !== "") {
        processLine(stderrBuffer);
        stderrBuffer = "";
      }
      scanCards();
    },
  };
}

const defaultDeps: DesignCommandDeps = {
  cwd: process.cwd(),
  invocationCwd: process.cwd(),
  workspaceContextScope: "workspace_required_mutation",
  env: process.env,
  readLine: readLineFromStdin,
  runLoopGo: loopGoCommand,
  now: () => Date.now(),
  heartbeatMs: 60_000,
  spawn: (bin, args, opts, live) => {
    return new Promise((resolveSpawn) => {
      const child = spawnChild(bin, args, { ...opts, stdio: ["inherit", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: DesignSpawnResult): void => {
        if (settled) return;
        settled = true;
        resolveSpawn(result);
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        live?.onStdout(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        live?.onStderr(chunk);
      });
      child.on("error", (err) => {
        const message = `${err instanceof Error ? err.message : String(err)}\n`;
        stderr += message;
        live?.onStderr(message);
        finish({ status: 1, signal: null, stdout, stderr });
      });
      child.on("close", (code, signal) => {
        finish({ status: code, signal, stdout, stderr });
      });
    });
  },
};

function selectAgent(
  installed: string[],
  forced: string | undefined,
  envAgent: string | undefined,
  primary: string | null,
  readLine: () => string | null,
): { agent: string | null; error: string | null } {
  if (forced !== undefined && forced !== "") {
    const canonical = installed.find((a) => a.toLowerCase() === forced.toLowerCase());
    if (canonical !== undefined) return { agent: canonical, error: null };
    return { agent: null, error: t(v3Catalog, lang(), "design.unknown_agent", forced) };
  }
  if (envAgent !== undefined && envAgent !== "") {
    const canonical = installed.find((a) => a.toLowerCase() === envAgent.toLowerCase());
    if (canonical !== undefined) return { agent: canonical, error: null };
    return { agent: null, error: t(v3Catalog, lang(), "design.unknown_agent", envAgent) };
  }
  if (primary !== null) {
    const canonical = installed.find((a) => a.toLowerCase() === primary.toLowerCase());
    if (canonical !== undefined) return { agent: canonical, error: null };
  }
  if (installed.length === 0) return { agent: null, error: null };
  if (installed.length === 1) return { agent: installed[0] ?? null, error: null };

  process.stderr.write(`${t(v2Catalog, lang(), "init.pick_an_agent")}\n`);
  installed.forEach((candidate, index) => {
    process.stderr.write(`    ${index + 1}) ${candidate}\n`);
  });
  process.stderr.write(`  Enter number [1-${installed.length}]: `);
  const choice = readLine();
  if (choice === null) {
    return { agent: null, error: t(v2Catalog, lang(), "init.no_input_received_aborting_onboard") };
  }
  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > installed.length) {
    return { agent: null, error: t(v2Catalog, lang(), "init.invalid_choice", choice) };
  }
  return { agent: installed[n - 1] ?? null, error: null };
}

interface RunContext {
  cwd: string;
  workspaceExecution?: WorkspaceExecutionContextV1;
  lang: Lang;
  target: string | null;
  fromFile: string | undefined;
  agent: string;
  installedAgents: string[];
  transcriptPath: string;
  startTs: number;
  beforeBacklog: { id: string; desc: string; status: string }[];
}

function printStartBlock(ctx: RunContext): void {
  const l = ctx.lang;
  const targetDisplay = ctx.fromFile !== undefined
    ? t(v3Catalog, l, "design.target_from_file", ctx.fromFile)
    : ctx.target !== null
      ? t(v3Catalog, l, "design.target", ctx.target)
      : t(v3Catalog, l, "design.target_none");
  const mode = ctx.fromFile !== undefined
    ? t(v3Catalog, l, "design.mode_from_file", ctx.fromFile)
    : isIdeaTarget(ctx.target)
      ? t(v3Catalog, l, "design.mode_design_only_idea")
      : t(v3Catalog, l, "design.mode_design_only");
  emit(t(v3Catalog, l, "design.run_started"));
  emit(targetDisplay);
  emit(mode);
  emit(t(v3Catalog, l, "design.agent", ctx.agent));
  emit(t(v3Catalog, l, "design.raw_transcript", relative(ctx.cwd, ctx.transcriptPath)));
}

function printHandoff(ctx: RunContext, statusCode: number, rawTranscript: string): void {
  const l = ctx.lang;
  const epic = ctx.target !== null ? lookupEpic(ctx.target, ctx.cwd, ctx.workspaceExecution) : null;
  const afterBacklog = readBacklogItems(ctx.cwd, ctx.workspaceExecution);
  const newCards = afterBacklog.filter((a) => !ctx.beforeBacklog.some((b) => b.id === a.id)).length;
  renderDesignReviewPageForTarget(ctx, newCards);
  let designPath: string | undefined;
  let reviewPagePath: string | undefined;
  if (epic !== null && ctx.target !== null) {
    const base = relative(ctx.cwd, authorityPath(ctx.cwd, ctx.workspaceExecution, "features", epic, ctx.target));
    const md = join(base, "spec.md");
    const reviewHtml = join(base, "design-review.html");
    const html = join(base, "spec.html");
    if (existsSync(resolve(ctx.cwd, md))) {
      designPath = hasDetailedDesign(resolve(ctx.cwd, md)) ? `${md}#detailed-design` : md;
    }
    if (existsSync(resolve(ctx.cwd, reviewHtml))) reviewPagePath = reviewHtml;
    else if (existsSync(resolve(ctx.cwd, html))) reviewPagePath = html;
  }

  let status: string;
  let why: string | undefined;
  let next: string | undefined;
  if (statusCode !== 0) {
    status = t(v3Catalog, l, "design.status.agent_failed", statusCode);
  } else if (newCards > 0) {
    status = t(v3Catalog, l, "design.status.cards_created", newCards);
    next = t(v3Catalog, l, "design.next.cards_created");
  } else if (isIdeaTarget(ctx.target)) {
    status = t(v3Catalog, l, "design.status.awaiting_signoff");
    why = t(v3Catalog, l, "design.why.idea_signoff");
    next = t(v3Catalog, l, "design.next.review_and_split", ctx.target ?? "");
  } else {
    status = t(v3Catalog, l, "design.status.no_cards");
    next = t(v3Catalog, l, "design.next.no_cards", ctx.target ?? t(v3Catalog, l, "design.target_none_label"));
  }

  emit("");
  emit(t(v3Catalog, l, "design.handoff"));
  emit(t(v3Catalog, l, "design.status_label", status));
  if (designPath !== undefined) emit(t(v3Catalog, l, "design.design_label", designPath));
  if (reviewPagePath !== undefined) emit(t(v3Catalog, l, "design.review_page_label", reviewPagePath));
  emit(t(v3Catalog, l, "design.cards_label", newCards));
  if (why !== undefined) emit(t(v3Catalog, l, "design.why_label", why));
  if (next !== undefined) emit(t(v3Catalog, l, "design.next_label", next));
  emit(t(v3Catalog, l, "design.transcript_label", relative(ctx.cwd, ctx.transcriptPath)));
  if (rawTranscript === "") {
    emit(t(v3Catalog, l, "design.empty_transcript"));
  }
}

function newTodoCards(ctx: RunContext): { id: string; desc: string; status: string }[] {
  const beforeIds = new Set(ctx.beforeBacklog.map((b) => b.id));
  return readBacklogItems(ctx.cwd, ctx.workspaceExecution).filter((row) => !beforeIds.has(row.id) && classifyStatus(row.status) === "todo");
}

function runtimeDir(cwd: string, context?: WorkspaceExecutionContextV1): string {
  return context?.authorities.runtime ?? projectRuntimePath(cwd);
}

function printAgentPoolSummary(ctx: RunContext): void {
  const state = readRigLifecycleState(runtimeDir(ctx.cwd, ctx.workspaceExecution));
  const suspended = ctx.installedAgents
    .map((agent) => ({ agent, entry: state.rigs[agent] }))
    .filter((item) => item.entry?.status === "suspended");
  const active = Math.max(0, ctx.installedAgents.length - suspended.length);
  emit(t(v3Catalog, ctx.lang, "design.loop.agent_pool", active, suspended.length));
  for (const { agent, entry } of suspended) {
    emit(t(v3Catalog, ctx.lang, "design.loop.suspended_agent", agent, entry?.cause ?? "unknown"));
  }
}

function maybeStartLoopAfterDesign(
  ctx: RunContext,
  d: DesignCommandDeps,
  statusCode: number,
): number | Promise<number> {
  if (statusCode !== 0) return statusCode;
  if (newTodoCards(ctx).length === 0) return statusCode;
  printAgentPoolSummary(ctx);
  emit(t(v3Catalog, ctx.lang, "design.loop.prompt"));
  const answer = (d.readLine() ?? "").trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    const started = d.runLoopGo(["--review", "auto"]);
    if (isPromiseLike(started)) return started.then((loopStatus) => (loopStatus === 0 ? statusCode : loopStatus));
    return started === 0 ? statusCode : started;
  }
  emit(t(v3Catalog, ctx.lang, "design.loop.manual_next"));
  return statusCode;
}

function runDesignCommand(
  args: string[],
  deps: Partial<DesignCommandDeps> = {},
  legacyAuthority?: symbol,
): number | Promise<number> {
  const d: DesignCommandDeps = {
    ...defaultDeps,
    ...deps,
    invocationCwd: deps.invocationCwd ?? deps.cwd ?? defaultDeps.invocationCwd,
  };
  const l = lang();

  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(`${t(v3Catalog, l, "design.usage")}\n`);
    return 0;
  }
  const { agent: forced, fromFile, verbose, raw: rawMode, rest, error: parseError } = parseDesignFlags(args);
  if (parseError === "from_file_missing") {
    emit(t(v3Catalog, l, "design.from_file_missing"));
    process.stderr.write(`${t(v3Catalog, l, "design.usage")}\n`);
    return 1;
  }
  if (rest.some((a) => a.startsWith("-"))) {
    // Unknown flag: print usage and fail loud (matches init flag handling).
    process.stderr.write(`${t(v3Catalog, l, "design.usage")}\n`);
    return 1;
  }
  if (fromFile !== undefined && rest.length > 0) {
    process.stderr.write(`${t(v3Catalog, l, "design.usage")}\n`);
    return 1;
  }

  if (
    d.workspaceExecution === undefined &&
    (
      legacyAuthority !== INIT_ONBOARD_DESIGN_AUTHORITY ||
      d.workspaceContextScope !== "legacy_migration_only" ||
      !authorizesLegacyWorkspaceContextOperation(d.workspaceContextOperationProvenance)
    )
  ) {
    emit("roll design: missing_execution_context");
    return 1;
  }

  if (!isRollProject(d.cwd)) {
    emit(t(v3Catalog, l, "design.not_roll_project"));
    return 1;
  }
  const resolvedFromFile = fromFile === undefined ? undefined : resolve(d.invocationCwd, fromFile);
  if (resolvedFromFile !== undefined && !isRegularFile(resolvedFromFile)) {
    emit(t(v3Catalog, l, "design.from_file_not_found", resolvedFromFile));
    return 1;
  }
  const promptFromFile = d.workspaceExecution === undefined ? fromFile : resolvedFromFile;

  // Bound bare design: no target and Todo backlog → bounded help, no spawn.
  if (fromFile === undefined && rest.length === 0) {
    if (hasTodoBacklog(d.cwd, d.workspaceExecution)) {
      process.stdout.write(`${t(v3Catalog, l, "design.bare_backlog_help")}\n`);
      return 0;
    }
    // Empty backlog → fall through (onboarding path may still launch agent).
  }

  const rawPrompt = readDesignPrompt(promptFromFile, rest);
  if (rawPrompt === null) {
    emit(t(v3Catalog, l, "design.skill_missing"));
    return 1;
  }

  const { installed } = discoverInteractiveAgents(agentEnvFromEnv(d.env));
  if (installed.length === 0) {
    emit(t(v3Catalog, l, "design.no_agent"));
    return 1;
  }

  const envAgent = d.env["ROLL_DESIGN_AGENT"];
  const primary = readPrimaryAgent();

  const { agent, error } = selectAgent(installed, forced, envAgent, primary, d.readLine);
  if (error !== null) {
    emit(error);
    return 1;
  }
  if (agent === null) {
    // Should only happen when installed is empty, already handled above.
    emit(t(v3Catalog, l, "design.no_agent"));
    return 1;
  }

  const legacyHandoff = d.workspaceExecution === undefined
    ? prepareLegacyWorkspaceSkillHandoff({
        skillName: "roll-design",
        operation: d.workspaceContextOperationProvenance!,
        skillBody: rawPrompt,
      })
    : undefined;
  const handoff = d.workspaceExecution === undefined
    ? { ok: true as const, skillBody: legacyHandoff!.skillBody }
    : prepareWorkspaceSkillHandoff({
        skillName: "roll-design",
        scope: "workspace_required_mutation",
        context: d.workspaceExecution,
        skillBody: rawPrompt,
      });
  if (!handoff.ok) {
    emit(`roll design: ${handoff.code}`);
    return 1;
  }
  const cmd = interactiveAgentCommand(agent, handoff.skillBody);
  if (cmd === null) {
    emit(t(v2Catalog, l, "init.agent_has_no_interactive_mode_wired", agent, agent));
    return 1;
  }

  const target = promptFromFile ?? (rest.join(" ").trim() || null);
  const startTs = d.now();
  const runTranscript = transcriptPath(d.cwd, startTs, target, d.workspaceExecution);
  mkdirSync(dirname(runTranscript), { recursive: true });
  writeFileSync(runTranscript, "", "utf8");

  const ctx: RunContext = {
    cwd: d.cwd,
    ...(d.workspaceExecution === undefined ? {} : { workspaceExecution: d.workspaceExecution }),
    lang: l,
    target,
    fromFile: promptFromFile,
    agent,
    installedAgents: installed,
    transcriptPath: runTranscript,
    startTs,
    beforeBacklog: readBacklogItems(d.cwd, d.workspaceExecution),
  };

  printStartBlock(ctx);

  const live = createLiveProgress(ctx, d, { raw: rawMode, verbose });
  live.startHeartbeat();

  const finish = (result: DesignSpawnResult): number | Promise<number> => {
    if (!live.sawLiveOutput) {
      live.ingestStdout(result.stdout ?? "");
      live.ingestStderr(result.stderr ?? "");
    } else {
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (stdout !== "" && !live.rawTranscript.includes(stdout)) live.ingestStdout(stdout);
      if (stderr !== "" && !live.rawTranscript.includes(stderr)) live.ingestStderr(stderr);
    }
    live.stopHeartbeat();
    live.flush();
    const statusCode = result.status ?? (result.signal === null ? 1 : 130);
    printHandoff(ctx, statusCode, live.rawTranscript);
    return maybeStartLoopAfterDesign(ctx, d, statusCode);
  };

  const spawned = d.spawn(
    cmd.bin,
    cmd.args,
    {
      cwd: d.cwd,
      env: {
        ...d.env,
        ...workspaceExecutionEnvironment(d.workspaceExecution),
        ...(legacyHandoff === undefined ? {} : {
          ROLL_WORKSPACE_CONTEXT_SCOPE: "legacy_migration_only",
          ROLL_WORKSPACE_LEGACY_HANDOFF: legacyHandoff.handoffJson,
        }),
      },
    },
    { onStdout: live.ingestStdout, onStderr: live.ingestStderr },
  );
  if (isPromiseLike(spawned)) {
    return spawned.then(finish, (err: unknown) => {
      live.ingestStderr(`${err instanceof Error ? err.message : String(err)}\n`);
      return finish({ status: 1, signal: null });
    });
  }
  return finish(spawned);
}

/** Public design entry: missing Workspace authority always fails closed. */
export function designCommand(args: string[], deps: Partial<DesignCommandDeps> = {}): number | Promise<number> {
  return runDesignCommand(args, deps);
}

/** Internal lifecycle entry used only by `roll init` before a Workspace exists. */
export function initOnboardDesignCommand(
  args: string[],
  deps: Partial<DesignCommandDeps> = {},
): number | Promise<number> {
  return runDesignCommand(args, {
    ...deps,
    workspaceContextScope: "legacy_migration_only",
    workspaceContextOperationProvenance: {
      surface: "cli",
      id: "init",
      operation: "onboard",
    },
  }, INIT_ONBOARD_DESIGN_AUTHORITY);
}
