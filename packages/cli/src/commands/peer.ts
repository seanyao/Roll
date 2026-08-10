/**
 * @responsibility Runs the `peer` subcommand, driving an external peer review session.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentsInstalled, parsePeerReviewTranscript, selectPeerReviewers, type PeerReviewFacts, type PeerReviewMode } from "@roll/core";
import { agentInstalledByName, projectAgent, realAgentEnv } from "./agent-list.js";
import { textAgentArgv, textAgentCommandFamily } from "../lib/text-agent-argv.js";

const DEFAULT_TIMEOUT_MS = 180_000;

export const PEER_HELP = `Usage: roll peer [--reviewer <agent>] [--worker <agent>] [--mode auto|hetero|self] (--prompt <text>|--file <path>) [--json] [--timeout-ms <ms>]
  Run one structured external-provider peer review and record .roll/peer/runs.jsonl.

  --reviewer <agent>  Use this reviewer directly.
  --worker <agent>    Working agent to compare against for hetero selection (default: project agent).
  --mode <mode>       auto selects hetero when available, hetero requires other provider, self allows same provider.
  --prompt <text>     Review prompt text.
  --file <path>       Read review prompt text from a file.
  --json              Print the structured reviewer facts as JSON.
  --timeout-ms <ms>   Per-review timeout (default 180000).

  运行一次结构化外部 provider peer review，并记录 .roll/peer/runs.jsonl。
`;

export interface SpawnPeerReviewInput {
  agent: string;
  projectPath: string;
  prompt: string;
  timeoutMs: number;
}

export type SpawnPeerReviewResult =
  | { status: "ok"; stdout: string }
  | { status: "timeout"; stdout: string }
  | { status: "error"; reason: string; stdout: string };

export interface PeerReviewRunInput {
  projectPath: string;
  prompt: string;
  mode: PeerReviewMode;
  workerAgents: string[];
  timeoutMs: number;
  reviewer?: string;
  purpose?: string;
}

export interface PeerReviewDeps {
  installedReviewers: () => string[];
  currentWorker: () => string;
  nowMs: () => number;
  nowIso: () => string;
  spawnReviewer: (input: SpawnPeerReviewInput) => Promise<SpawnPeerReviewResult>;
}

function realDeps(): PeerReviewDeps {
  return {
    installedReviewers: () => reviewAgentPool(),
    currentWorker: () => projectAgent(),
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    spawnReviewer: spawnPeerReviewAgent,
  };
}

function reviewAgentPool(): string[] {
  const installed = agentsInstalled(realAgentEnv());
  const current = projectAgent();
  return uniqueStrings(agentInstalledByName(current) ? [...installed, current] : installed);
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > 100_000 ? next.slice(-100_000) : next;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      /* not a process group leader or already gone */
    }
  }
  return child.kill(signal);
}

function releaseChild(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

export function spawnPeerReviewAgent(input: SpawnPeerReviewInput): Promise<SpawnPeerReviewResult> {
  const cmd = textAgentArgv(input.agent, input.prompt);
  if (cmd === null) return Promise.resolve({ status: "error", reason: "unsupported_reviewer", stdout: "" });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(cmd.bin, cmd.args, {
      cwd: input.projectPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const finish = (result: SpawnPeerReviewResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGKILL");
      releaseChild(child);
      finish({ status: "timeout", stdout });
    }, input.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (error) => finish({ status: "error", reason: error.message, stdout }));
    child.on("exit", (code, signal) => {
      setImmediate(() => {
        if (timedOut) finish({ status: "timeout", stdout });
        else if (code === 0) finish({ status: "ok", stdout });
        else finish({ status: "error", reason: `exit_${code ?? signal ?? "signal"}:${stderr.trim().slice(0, 200)}`, stdout });
      });
    });
    child.on("close", (code) => {
      if (timedOut) finish({ status: "timeout", stdout });
      else if (code === 0) finish({ status: "ok", stdout });
      else finish({ status: "error", reason: `exit_${code ?? "signal"}:${stderr.trim().slice(0, 200)}`, stdout });
    });
  });
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "peer";
}

function peerDir(projectPath: string): string {
  return join(projectPath, ".roll", "peer");
}

function transcriptPath(projectPath: string, iso: string, reviewer: string): string {
  return join(peerDir(projectPath), "transcripts", `${safePart(iso)}-${safePart(reviewer)}.txt`);
}

function runsPath(projectPath: string): string {
  return join(peerDir(projectPath), "runs.jsonl");
}

function writePeerFacts(projectPath: string, facts: PeerReviewFacts, transcript: string | undefined): PeerReviewFacts {
  mkdirSync(join(peerDir(projectPath), "transcripts"), { recursive: true });
  let next = facts;
  if (transcript !== undefined) {
    const path = facts.transcriptPath ?? transcriptPath(projectPath, new Date().toISOString(), facts.agent || "none");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, transcript, "utf8");
    next = { ...next, transcriptPath: path };
  }
  const runPath = runsPath(projectPath);
  mkdirSync(dirname(runPath), { recursive: true });
  next = { ...next, evidencePath: runPath };
  appendFileSync(runPath, `${JSON.stringify(next)}\n`, "utf8");
  return next;
}

function unavailableFacts(reason: string, durationMs: number): PeerReviewFacts {
  return {
    agent: "",
    provider: "",
    commandFamily: "",
    verdict: "ERROR",
    reason,
    findings: [],
    durationMs,
    error: reason,
  };
}

export async function runPeerReview(input: PeerReviewRunInput, deps: PeerReviewDeps = realDeps()): Promise<PeerReviewFacts> {
  const started = deps.nowMs();
  const candidates = deps.installedReviewers();
  const selection = selectPeerReviewers({
    mode: input.mode,
    candidates,
    workerAgents: input.workerAgents.length > 0 ? input.workerAgents : [deps.currentWorker()],
    ...(input.reviewer !== undefined ? { requestedReviewer: input.reviewer } : {}),
  });
  if (selection.status === "unavailable") {
    return writePeerFacts(input.projectPath, unavailableFacts(selection.reason, deps.nowMs() - started), undefined);
  }

  let lastFacts: PeerReviewFacts | undefined;
  for (const reviewer of selection.reviewers) {
    const commandFamily = textAgentCommandFamily(reviewer.reviewer) ?? reviewer.reviewer;
    const ran = await deps.spawnReviewer({
      agent: reviewer.reviewer,
      projectPath: input.projectPath,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
    });
    const durationMs = deps.nowMs() - started;
    const base = {
      agent: reviewer.reviewer,
      provider: reviewer.provider,
      commandFamily,
      effectiveMode: reviewer.effectiveMode,
      findings: [],
      durationMs,
      ...(reviewer.degraded ? { degradedReason: reviewer.reason ?? "single_provider_available" } : {}),
    };
    const path = transcriptPath(input.projectPath, deps.nowIso(), reviewer.reviewer);

    let facts: PeerReviewFacts;
    if (ran.status === "timeout") {
      facts = {
        ...base,
        verdict: "TIMEOUT",
        reason: "peer_review_timeout",
        findings: parsePeerReviewTranscript(ran.stdout).findings,
        transcriptPath: path,
      };
    } else if (ran.status === "error") {
      facts = {
        ...base,
        verdict: "ERROR",
        reason: ran.reason,
        findings: parsePeerReviewTranscript(ran.stdout).findings,
        transcriptPath: path,
        error: ran.reason,
      };
    } else {
      const parsed = parsePeerReviewTranscript(ran.stdout);
      facts = { ...base, verdict: parsed.verdict, reason: parsed.reason, findings: parsed.findings, transcriptPath: path };
    }
    writePeerFacts(input.projectPath, facts, ran.stdout);
    lastFacts = facts;
    if (ran.status === "ok") return facts;
  }
  return lastFacts ?? writePeerFacts(input.projectPath, unavailableFacts("no_peer_succeeded", deps.nowMs() - started), undefined);
}

interface PeerOptions {
  reviewer?: string;
  worker?: string;
  mode: PeerReviewMode;
  prompt?: string;
  file?: string;
  timeoutMs: number;
  json: boolean;
}

function parseOptions(args: string[]): PeerOptions {
  let reviewer: string | undefined;
  let worker: string | undefined;
  let mode: PeerReviewMode = "auto";
  let prompt: string | undefined;
  let file: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--reviewer" || arg === "--agent") {
      reviewer = requiredValue(args, ++i, arg);
      continue;
    }
    if (arg.startsWith("--reviewer=")) {
      reviewer = nonEmptyValue(arg.slice("--reviewer=".length), "--reviewer");
      continue;
    }
    if (arg === "--worker") {
      worker = requiredValue(args, ++i, "--worker");
      continue;
    }
    if (arg.startsWith("--worker=")) {
      worker = nonEmptyValue(arg.slice("--worker=".length), "--worker");
      continue;
    }
    if (arg === "--mode") {
      mode = parseMode(requiredValue(args, ++i, "--mode"));
      continue;
    }
    if (arg.startsWith("--mode=")) {
      mode = parseMode(arg.slice("--mode=".length));
      continue;
    }
    if (arg === "--prompt") {
      prompt = requiredValue(args, ++i, "--prompt");
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      prompt = nonEmptyValue(arg.slice("--prompt=".length), "--prompt");
      continue;
    }
    if (arg === "--file") {
      file = requiredValue(args, ++i, "--file");
      continue;
    }
    if (arg.startsWith("--file=")) {
      file = nonEmptyValue(arg.slice("--file=".length), "--file");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parseTimeout(requiredValue(args, ++i, "--timeout-ms"));
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseTimeout(arg.slice("--timeout-ms=".length));
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`roll peer: unknown argument ${arg}`);
  }
  return { ...(reviewer !== undefined ? { reviewer } : {}), ...(worker !== undefined ? { worker } : {}), mode, ...(prompt !== undefined ? { prompt } : {}), ...(file !== undefined ? { file } : {}), timeoutMs, json };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  return nonEmptyValue(args[index], flag);
}

function nonEmptyValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "" || value.startsWith("--")) throw new Error(`roll peer: ${flag} requires a value`);
  return value;
}

function parseMode(value: string | undefined): PeerReviewMode {
  if (value === "auto" || value === "hetero" || value === "self") return value;
  throw new Error("roll peer: --mode must be auto, hetero, or self");
}

function parseTimeout(value: string | undefined): number {
  const n = Number((value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("roll peer: --timeout-ms must be a positive number");
  return n;
}

function readPrompt(opts: PeerOptions): string {
  if (opts.prompt !== undefined && opts.file !== undefined) throw new Error("roll peer: use either --prompt or --file, not both");
  if (opts.prompt !== undefined) return opts.prompt;
  if (opts.file !== undefined) return readFileSync(opts.file, "utf8");
  throw new Error("roll peer: --prompt or --file is required");
}

export async function peerCommand(args: string[], deps: PeerReviewDeps = realDeps()): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(PEER_HELP);
    return 0;
  }
  let opts: PeerOptions;
  try {
    opts = parseOptions(args);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  let prompt: string;
  try {
    prompt = readPrompt(opts);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const facts = await runPeerReview(
    {
      projectPath: process.cwd(),
      prompt,
      mode: opts.mode,
      workerAgents: opts.worker !== undefined ? [opts.worker] : [deps.currentWorker()],
      timeoutMs: opts.timeoutMs,
      ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
      purpose: "one_shot",
    },
    deps,
  );
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
  } else {
    process.stdout.write(
      `peer review: ${facts.verdict}\n` +
        `reviewer: ${facts.agent || "(none)"} · provider: ${facts.provider || "(none)"} · command: ${facts.commandFamily || "(none)"}\n` +
        `reason: ${facts.reason}\n` +
        `duration: ${facts.durationMs}ms\n` +
        (facts.evidencePath !== undefined ? `evidence: ${facts.evidencePath}\n` : ""),
    );
  }
  return facts.verdict === "ERROR" || facts.verdict === "TIMEOUT" ? 1 : 0;
}
