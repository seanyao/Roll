/**
 * @responsibility Probes configured model rigs at the CLI and infra boundary.
 */
/**
 * US-DELTA-018 — CLI/infra boundary for exact configured-model rig probes.
 *
 * This module intentionally contains the vendor executable vocabulary. It has
 * no Delta lifecycle imports and returns observations only; callers decide
 * whether a complete set is safe to persist as a local readiness snapshot.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RigProbeObservation, RigProbeReasonCode, RigReadinessCandidate } from "@roll/spec";

/** Deliberately boring token: a successful probe must return precisely this. */
export const RIG_PROBE_TOKEN = "ROLL_RIG_READY_V1";

const MAX_PROCESS_OUTPUT_CHARS = 4_096;
const MAX_DETAIL_CHARS = 320;

export interface RigProbeRequest {
  readonly adapter: string;
  /** Opaque configured CLI model id — it is never normalized or substituted. */
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly token: string;
}

export interface RigProbeResult {
  readonly outcome: "ready" | "blocked" | "unknown";
  readonly reasonCode: RigProbeReasonCode;
  /** A redacted, bounded owner-actionable message only. */
  readonly detail: string;
  readonly latencyMs?: number;
}

export interface RigProbeAdapter {
  readonly adapter: string;
  probe(request: RigProbeRequest): Promise<RigProbeResult>;
}

export interface RigProbeRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface RigProbeProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly errorCode?: string;
}

export interface RigProbeDependencies {
  readonly makeTempDir: () => string;
  readonly removeTempDir: (path: string) => void;
  readonly now: () => number;
  readonly run: (command: string, args: readonly string[], options: RigProbeRunOptions) => Promise<RigProbeProcessResult>;
}

interface AdapterSpec {
  readonly adapter: string;
  readonly command?: string;
  readonly argv?: (request: RigProbeRequest) => readonly string[];
  readonly unsupported?: true;
}

/**
 * Each executable gets a deliberately fixed noninteractive exact-model form.
 * No adapter uses a default model or a retry/fallback route. Cursor is kept
 * visible but deliberately unexecutable until it offers an equally safe exact
 * noninteractive selector.
 */
const ADAPTER_SPECS: readonly AdapterSpec[] = [
  {
    adapter: "claude",
    command: "claude",
    argv: (request) => ["--print", "--model", request.modelId, "--no-session-persistence", request.token],
  },
  {
    adapter: "codex",
    command: "codex",
    argv: (request) => ["exec", "--model", request.modelId, "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", request.token],
  },
  {
    adapter: "pi",
    command: "pi",
    argv: (request) => ["--print", "--model", request.modelId, "--no-session", request.token],
  },
  {
    adapter: "kimi",
    command: "kimi",
    argv: (request) => ["--print", "--model", request.modelId, "--no-session", request.token],
  },
  {
    adapter: "reasonix",
    command: "reasonix",
    argv: (request) => ["run", "--model", request.modelId, "--no-session", request.token],
  },
  { adapter: "cursor", unsupported: true },
];

/** The production seams still make a child-process probe bounded and isolated. */
export function nodeRigProbeDependencies(): RigProbeDependencies {
  return {
    makeTempDir: () => mkdtempSync(join(tmpdir(), "roll-rig-probe-")),
    removeTempDir: (path) => rmSync(path, { recursive: true, force: true }),
    now: () => Date.now(),
    run: runNodeProcess,
  };
}

/** Construct every known adapter, including safe no-execution blocked adapters. */
export function createRigProbeAdapters(deps: RigProbeDependencies = nodeRigProbeDependencies()): ReadonlyMap<string, RigProbeAdapter> {
  return new Map(ADAPTER_SPECS.map((spec) => [spec.adapter, createAdapter(spec, deps)]));
}

/**
 * Probe in a bounded worker pool. An adapter's classified result is an
 * observation; a thrown/aborted worker is fatal because publishing an
 * incomplete snapshot would incorrectly look complete.
 */
export async function runRigReadinessProbes(
  candidates: readonly RigReadinessCandidate[],
  maxConcurrency: number,
  adapters: ReadonlyMap<string, RigProbeAdapter>,
  token = RIG_PROBE_TOKEN,
): Promise<readonly RigProbeObservation[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("rig probe maxConcurrency must be a positive integer");
  const results: Array<RigProbeObservation | undefined> = new Array(candidates.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const candidate = candidates[index]!;
      const adapter = adapters.get(candidate.adapter);
      if (adapter === undefined) throw new Error(`no rig probe adapter for ${JSON.stringify(candidate.adapter)}`);
      const result = await adapter.probe({
        adapter: candidate.adapter,
        modelId: candidate.cliModelId,
        timeoutMs: 60_000, // callers validate configured limits before reaching this boundary
        token,
      });
      results[index] = {
        adapter: candidate.adapter,
        configuredModelId: candidate.configuredModelId,
        cliModelId: candidate.cliModelId,
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        detail: result.detail,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, candidates.length) }, () => worker()));
  if (results.some((result) => result === undefined)) throw new Error("rig probe worker completed without an observation");
  return results as readonly RigProbeObservation[];
}

/** Preserve the caller's validated timeout without widening this public helper. */
export async function runRigReadinessProbesWithTimeout(
  candidates: readonly RigReadinessCandidate[],
  maxConcurrency: number,
  timeoutMs: number,
  adapters: ReadonlyMap<string, RigProbeAdapter>,
  token = RIG_PROBE_TOKEN,
): Promise<readonly RigProbeObservation[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("rig probe timeout must be an integer from 1000 to 60000");
  const wrapped = new Map([...adapters].map(([name, adapter]) => [name, {
    adapter: adapter.adapter,
    probe: (request: RigProbeRequest) => adapter.probe({ ...request, timeoutMs }),
  } satisfies RigProbeAdapter]));
  return runRigReadinessProbes(candidates, maxConcurrency, wrapped, token);
}

function createAdapter(spec: AdapterSpec, deps: RigProbeDependencies): RigProbeAdapter {
  if (spec.unsupported) {
    return {
      adapter: spec.adapter,
      async probe() {
        return blocked("adapter_model_selection_unsupported", "This adapter has no verified exact-model noninteractive probe; it was not executed.");
      },
    };
  }
  const command = spec.command!;
  const argv = spec.argv!;
  return {
    adapter: spec.adapter,
    async probe(request) {
      const startedAt = deps.now();
      const cwd = deps.makeTempDir();
      try {
        const result = await deps.run(command, argv(request), {
          cwd,
          env: minimalProbeEnvironment(),
          timeoutMs: request.timeoutMs,
        });
        const latencyMs = Math.max(0, deps.now() - startedAt);
        return classifyProcessResult(result, request.token, latencyMs);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
        if (code === "ENOENT") return blocked("adapter_missing", `The ${spec.adapter} executable was not found; install it before refreshing readiness.`);
        return unknown("probe_failed", "The exact-model probe could not start or finish; retry after checking the local adapter.");
      } finally {
        try { deps.removeTempDir(cwd); } catch { /* cleanup is best effort; no probe material is persisted */ }
      }
    },
  };
}

function minimalProbeEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

function classifyProcessResult(result: RigProbeProcessResult, token: string, latencyMs: number): RigProbeResult {
  if (result.errorCode === "ENOENT") return blocked("adapter_missing", "The adapter executable was not found; install it before refreshing readiness.");
  if (result.timedOut) return unknown("probe_timeout", "The exact-model probe timed out; retry or increase the validated timeout.", latencyMs);
  const known = classifyKnownDiagnostic(`${result.stderr}\n${result.stdout}`);
  if (known !== undefined) return blocked(known, detailForKnownDiagnostic(known), latencyMs);
  if (result.code === 0) {
    if (containsProbeToken(result.stdout, token)) return ready(latencyMs);
    return unknown("probe_output_unverified", "The adapter exited cleanly but its output never included the fixed probe token.", latencyMs);
  }
  return unknown("probe_failed", "The exact-model probe failed without a recognized actionable diagnostic.", latencyMs);
}

function classifyKnownDiagnostic(raw: string): Extract<RigProbeReasonCode, "auth_required" | "quota_exhausted" | "rate_limited" | "network_unreachable" | "model_rejected"> | undefined {
  const detail = redactProbeDetail(raw).toLowerCase();
  if (/\b(401|403|unauthori[sz]ed|authentication|api[ _-]?key|login required)\b/.test(detail)) return "auth_required";
  if (/\b(quota|billing|insufficient credits|credit balance)\b/.test(detail)) return "quota_exhausted";
  if (/\b(429|rate limit|too many requests)\b/.test(detail)) return "rate_limited";
  if (/\b(network|econnrefused|enotfound|dns|connection reset|timed out)\b/.test(detail)) return "network_unreachable";
  if (/\b(model .*?(not found|unsupported|denied|rejected)|invalid model|unknown model)\b/.test(detail)) return "model_rejected";
  return undefined;
}

function detailForKnownDiagnostic(reason: RigProbeReasonCode): string {
  switch (reason) {
    case "auth_required": return "Authentication is required for this exact model; sign in to the local adapter and retry.";
    case "quota_exhausted": return "The provider quota or credits are unavailable for this exact model; restore access and retry.";
    case "rate_limited": return "The provider rate-limited this exact model; wait and refresh again.";
    case "network_unreachable": return "The adapter could not reach its service; check network or VPN access and retry.";
    case "model_rejected": return "The configured exact model was rejected; correct its local rig mapping and retry.";
    default: return "The exact-model probe is unavailable.";
  }
}

function ready(latencyMs: number): RigProbeResult {
  return { outcome: "ready", reasonCode: "probe_passed", detail: "The exact configured model returned the fixed minimal probe token.", latencyMs };
}

function blocked(reasonCode: Extract<RigProbeReasonCode, "adapter_missing" | "adapter_model_selection_unsupported" | "auth_required" | "quota_exhausted" | "rate_limited" | "network_unreachable" | "model_rejected">, detail: string, latencyMs?: number): RigProbeResult {
  return { outcome: "blocked", reasonCode, detail: redactProbeDetail(detail), ...(latencyMs === undefined ? {} : { latencyMs }) };
}

function unknown(reasonCode: Extract<RigProbeReasonCode, "probe_timeout" | "probe_output_unverified" | "probe_failed">, detail: string, latencyMs?: number): RigProbeResult {
  return { outcome: "unknown", reasonCode, detail: redactProbeDetail(detail), ...(latencyMs === undefined ? {} : { latencyMs }) };
}

function normalizeProbeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

/**
 * A healthy CLI often wraps the fixed probe token in banner lines, auth
 * disclaimers, or trailing punctuation — conversational models rarely emit
 * only the bare token and nothing else. Requiring byte-exact equality of the
 * whole output made real, working rigs read as "unverified" on nothing more
 * than incidental surrounding text. Require the token to appear as a
 * standalone word instead: still rejects outputs that never mention it, but
 * no longer rejects outputs that mention it plus something else.
 */
function containsProbeToken(stdout: string, token: string): boolean {
  const normalized = normalizeProbeOutput(stdout);
  if (normalized === token) return true;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`).test(normalized);
}

/** Exported for deterministic boundary tests and to prevent accidental raw diagnostics rendering. */
export function redactProbeDetail(value: string): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/\b(bearer|token|api[_-]?key|authorization)\s*[:=]?\s+[^\s,;]+/gi, "$1 <redacted>")
    .replace(/\b(sk|rk|pk)-[a-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(/(?:\/Users\/|\/home\/)[^\s,;:]+/g, "<home>")
    .replace(/[A-Za-z]:\\Users\\[^\s,;:]+/g, "<home>")
    .replace(/\{[^{}]{0,1024}\}/g, "<provider response redacted>");
  return redacted.length <= MAX_DETAIL_CHARS ? redacted : `${redacted.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function runNodeProcess(command: string, args: readonly string[], options: RigProbeRunOptions): Promise<RigProbeProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (result: RigProbeProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      finish({ code: null, stdout, stderr, errorCode: code });
      return;
    }
    const append = (current: string, chunk: Buffer): string => current.length >= MAX_PROCESS_OUTPUT_CHARS ? current : `${current}${chunk.toString("utf8")}`.slice(0, MAX_PROCESS_OUTPUT_CHARS);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, errorCode: error.code }));
    child.once("close", (code) => finish({ code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) }));
    timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* close handler reports the bounded result */ }
    }, options.timeoutMs);
    forceKill = setTimeout(() => {
      if (!settled) {
        try { child.kill("SIGKILL"); } catch { /* close handler reports the bounded result */ }
      }
    }, options.timeoutMs + 250);
  });
}
