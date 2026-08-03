/**
 * FIX-363 (2/2) — distinguish a SLOW peer review from an externally BLOCKED agent.
 *
 * The pairing gate kills a reviewer at its wall-clock budget. But a "timeout" is
 * not always slowness — the owner's observation: an agent can hang because it is
 * NOT LOGGED IN (403 / "Please run /login") or the NETWORK is down (VPN off /
 * proxy dead). Raising the budget then makes it worse: we wait 5min for a call
 * that will NEVER return, then fail anyway, and after 3 such cycles the loop
 * auto-pauses with a MISLEADING "3 consecutive failures — resolve the root cause"
 * that sends the owner hunting a phantom code bug. The real fix is "re-login" or
 * "reconnect the VPN".
 *
 * Evidence this is real: the `pair:consult` history shows ALL 55 timeouts landing
 * at EXACTLY ~120004ms (hang-until-killed), not a spread — the signature of an
 * external block, not of slow generation. And this very session opened with two
 * `API Error: 403 Request not allowed / Please run /login`.
 *
 * Design (peer-reviewed with kimi + pi — both preferred attribution over a
 * per-cycle synchronous probe):
 *   1. {@link classifyBlockSignature} runs on output we ALREADY captured (zero
 *      cost). It catches the case where the blocked agent printed a 403 / login /
 *      ENOTFOUND / proxy message.
 *   2. {@link probeAgentReachable} is a FAILURE-PATH disambiguator: only when a
 *      review died as a SILENT timeout (killed, no signature in its output) do we
 *      spend one cheap trivial-prompt probe to tell "blocked" from "slow". A live
 *      agent answers a one-token echo in seconds; a blocked one errors fast or
 *      hangs to the (short) cap. This is a CONNECTIVITY/REACHABILITY check, NOT a
 *      readiness promise — `reachable` never guarantees the heavy review will
 *      complete (rate-limits / context limits surface only under real load).
 *
 * The signatures are HEURISTICS. They drive a heuristic (suppress the
 * code-failure counter, raise an actionable alert), never a hard correctness
 * gate — so a false positive degrades to "the owner gets a slightly-wrong hint",
 * never "a real delivery is dropped". And because the probe prompt is a fixed
 * echo (not arbitrary diff text), the broad CN/EN substrings cannot be tripped by
 * a diff that happens to mention "login" or "network".
 */
import type { RollEvent } from "@roll/spec";
import { killLiveAgents, type AgentSpawn } from "./agent-spawn.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Why an agent could not be reached. `unknown` = hung/failed with no signature
 *  we can attribute (treated as soft — never drives the all-blocked alert). */
export type BlockCause = "quota" | "auth" | "network" | "unknown";

// E7: `main_checkout_leak` is a distinct death cause from `agent_stall` — the
// watchdog SIGKILL'd the agent for writing outside its sandbox (into the main
// checkout), which folds into `timedOut` for teardown but must NOT be reported
// as a timeout: mislabeling it agent_stall misdirected on-call to a no-progress
// hunt when the real cause was a sandbox escape.
export type RigSuspendCause = "quota" | "auth" | "network" | "agent_stall" | "main_checkout_leak";

export interface RigLifecycleEntry {
  readonly status: "active" | "suspended";
  readonly cause?: RigSuspendCause;
  readonly detail?: string;
  readonly suspendedAt?: number;
  readonly nextProbeAt?: number;
}

export interface RigLifecycleState {
  readonly rigs: Record<string, RigLifecycleEntry>;
}

export interface ReachResult {
  agent: string;
  reachable: boolean;
  cause: BlockCause | "live";
  detail: string;
}

// Auth-block signatures: the agent ran but is not authenticated.
const QUOTA_SIGNATURES: RegExp[] = [
  /\bquota\b/i,
  /\brate\s*limit/i,
  /\b429\b.{0,60}\b(limit|quota|too many requests)\b/i,
  /\b(insufficient|exceeded|exhausted|out of)\b.{0,40}\b(quota|credits?|balance|tokens?)\b/i,
  /\b(quota|credits?|balance|tokens?)\b.{0,40}\b(insufficient|exceeded|exhausted|used up)\b/i,
  /额度(不足|已用完|耗尽|超限)|配额(不足|已用完|耗尽|超限)|余额不足|限流/,
];

const AUTH_SIGNATURES: RegExp[] = [
  /\/login\b/i,
  /\bplease\s+run\s+\/?login\b/i,
  /\blog ?in\s+(required|needed)\b/i,
  /\b(required|need|needs|must|please)\b.{0,40}\blog ?in\b/i,
  /\bsign ?in\s+(required|needed)\b/i,
  /\b(required|need|needs|must|please)\b.{0,40}\bsign ?in\b/i,
  /\b(?:API Error|HTTP)\b.{0,30}\b40[13]\b/i,
  /\b40[13]\b.{0,30}\b(?:request not allowed|unauthorized|forbidden|please run|login|proxy)\b/i,
  /unauthor/i,
  /not authenticated/i,
  /authentication (failed|required|error)/i,
  /\b(invalid|missing|expired|required)\b.{0,30}\bapi[_ -]?key\b/i,
  /\bapi[_ -]?key\b.{0,30}\b(invalid|missing|expired|required)\b/i,
  /request not allowed/i,
  /\bcredential(s)?\b.{0,30}\b(missing|required|invalid|expired|error|failed)\b/i,
  /\b(missing|required|invalid|expired|error|failed)\b.{0,30}\bcredential(s)?\b/i,
  /请.*登录|登录.*(失败|过期|后重试|必需|需要)/,
  /鉴权(失败|错误|过期)|认证失败|未授权/,
];

// Network-block signatures: cannot reach the API (VPN/proxy down, DNS, TLS).
const NETWORK_SIGNATURES: RegExp[] = [
  /ENOTFOUND/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /getaddrinfo/i,
  /fetch failed/i,
  /socket hang ?up/i,
  /\bproxy\b/i,
  /network (error|is )?(un)?reachable/i,
  /could not (resolve|connect)/i,
  /connection (refused|reset|timed out|error)/i,
  /\b(certificate|self-signed|tls|ssl) /i,
  /tunnel/i,
  /代理|网络(错误|不可达|连接)/,
];

/**
 * Classify a chunk of agent output for an external-block signature. AUTH wins
 * over NETWORK when both match (a 403 behind a working proxy is still an auth
 * problem). Returns null when nothing matches → treat as live/slow.
 */
export function classifyBlockSignature(text: string): "quota" | "auth" | "network" | null {
  if (text === "") return null;
  if (QUOTA_SIGNATURES.some((r) => r.test(text))) return "quota";
  if (AUTH_SIGNATURES.some((r) => r.test(text))) return "auth";
  if (NETWORK_SIGNATURES.some((r) => r.test(text))) return "network";
  return null;
}

export interface ProbeOptions {
  /** Working dir for the probe spawn (default process.cwd()). */
  cwd?: string;
  /** Hard cap (default 20s). A live agent answers a one-token echo in seconds;
   *  a blocked one errors fast or hangs to the cap. Generous enough to absorb a
   *  cold start (kimi/codex), short enough to not be "耗着". */
  timeoutMs?: number;
  /** The token the agent is asked to echo (default ROLL_LIVE_OK). */
  token?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const PROBE_TOKEN = "ROLL_LIVE_OK";

/**
 * Cheap connectivity/auth probe — spawn the agent on a trivial echo prompt with a
 * short hard cap, then classify. Used ONLY on the review failure path (a silent
 * timeout with no signature) to tell a blocked agent from a slow one, so the loop
 * acts on the real cause instead of burning the (now longer) review budget on a
 * doomed call. Never throws.
 */
export async function probeAgentReachable(
  agent: string,
  spawn: AgentSpawn,
  opts: ProbeOptions = {},
): Promise<ReachResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const token = opts.token ?? PROBE_TOKEN;
  const cwd = opts.cwd ?? process.cwd();
  let res;
  try {
    res = await Promise.race([
      spawn(agent, { cwd, skillBody: `Reply with exactly: ${token}`, timeoutMs, bare: true }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref();
      }),
    ]);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const sig = classifyBlockSignature(detail);
    return { agent, reachable: false, cause: sig ?? "unknown", detail: firstLine(detail) };
  }
  if (res === null || res.timedOut) {
    // Hung to the cap with no answer to a one-token prompt → almost certainly an
    // external block, but we can't say WHICH → unknown (soft).
    return { agent, reachable: false, cause: "unknown", detail: "probe hung (no response to echo)" };
  }
  const text = `${res.stdout}\n${res.stderr}`;
  const sig = classifyBlockSignature(text);
  if (sig !== null) return { agent, reachable: false, cause: sig, detail: firstLine(text) };
  if (res.exitCode !== 0) {
    return { agent, reachable: false, cause: "unknown", detail: `exit ${res.exitCode}: ${firstLine(text)}` };
  }
  // exit 0, no block signature → reachable. We do NOT require an exact token
  // match: some agents prepend reasoning; a clean non-error reply is enough.
  return { agent, reachable: true, cause: "live", detail: "ok" };
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 200);
}

export const DEFAULT_RIG_RECOVERY_PROBE_MS = 30 * 60 * 1000;

export function rigLifecycleStatePath(runtimeDir: string): string {
  return join(runtimeDir, "rig-lifecycle.json");
}

export function readRigLifecycleState(runtimeDir: string): RigLifecycleState {
  const path = rigLifecycleStatePath(runtimeDir);
  try {
    if (!existsSync(path)) return { rigs: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return { rigs: {} };
    const raw = (parsed as Record<string, unknown>)["rigs"];
    if (raw === null || typeof raw !== "object") return { rigs: {} };
    const rigs: Record<string, RigLifecycleEntry> = {};
    for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const status = rec["status"];
      if (status !== "active" && status !== "suspended") continue;
      const cause = rec["cause"];
      const validCause =
        cause === "quota" ||
        cause === "auth" ||
        cause === "network" ||
        cause === "agent_stall" ||
        cause === "main_checkout_leak";
      rigs[agent] = {
        status,
        ...(validCause ? { cause } : {}),
        ...(typeof rec["detail"] === "string" ? { detail: rec["detail"] } : {}),
        ...(typeof rec["suspendedAt"] === "number" ? { suspendedAt: rec["suspendedAt"] } : {}),
        ...(typeof rec["nextProbeAt"] === "number" ? { nextProbeAt: rec["nextProbeAt"] } : {}),
      };
    }
    return { rigs };
  } catch {
    return { rigs: {} };
  }
}

export function writeRigLifecycleState(runtimeDir: string, state: RigLifecycleState): void {
  mkdirSync(runtimeDir, { recursive: true });
  const path = rigLifecycleStatePath(runtimeDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function suspendRig(
  runtimeDir: string,
  agent: string,
  cause: RigSuspendCause,
  detail: string,
  nowMs = Date.now(),
  probeAfterMs = DEFAULT_RIG_RECOVERY_PROBE_MS,
): RigLifecycleEntry {
  const state = readRigLifecycleState(runtimeDir);
  const entry: RigLifecycleEntry = {
    status: "suspended",
    cause,
    detail,
    suspendedAt: nowMs,
    nextProbeAt: nowMs + probeAfterMs,
  };
  try {
    writeRigLifecycleState(runtimeDir, { rigs: { ...state.rigs, [agent]: entry } });
  } catch {
    /* runtime lifecycle is best-effort; event stream still carries the signal */
  }
  return entry;
}

export function recoverRig(runtimeDir: string, agent: string): RigLifecycleEntry {
  const state = readRigLifecycleState(runtimeDir);
  const entry: RigLifecycleEntry = { status: "active" };
  try {
    writeRigLifecycleState(runtimeDir, { rigs: { ...state.rigs, [agent]: entry } });
  } catch {
    /* runtime lifecycle is best-effort; event stream still carries the signal */
  }
  return entry;
}

export function activeRigs(agents: readonly string[], state: RigLifecycleState): string[] {
  return agents.filter((agent) => state.rigs[agent]?.status !== "suspended");
}

export function suspendedRigs(agents: readonly string[], state: RigLifecycleState): Array<{ agent: string; entry: RigLifecycleEntry }> {
  return agents
    .map((agent) => ({ agent, entry: state.rigs[agent] }))
    .filter((item): item is { agent: string; entry: RigLifecycleEntry } => item.entry?.status === "suspended");
}

export async function probeDueSuspendedRigs(opts: {
  runtimeDir: string;
  agents: readonly string[];
  nowMs: number;
  probe: (agent: string) => Promise<ReachResult>;
  onProbe?: (result: { agent: string; recovered: boolean; entry: RigLifecycleEntry; detail: string }) => void;
}): Promise<RigLifecycleState> {
  let state = readRigLifecycleState(opts.runtimeDir);
  for (const { agent, entry } of suspendedRigs(opts.agents, state)) {
    if ((entry.nextProbeAt ?? 0) > opts.nowMs) continue;
    const reach = await opts.probe(agent);
    if (reach.reachable) {
      recoverRig(opts.runtimeDir, agent);
      state = readRigLifecycleState(opts.runtimeDir);
      opts.onProbe?.({ agent, recovered: true, entry: { status: "active" }, detail: reach.detail });
      continue;
    }
    const cause = entry.cause ?? (reach.cause === "quota" || reach.cause === "auth" || reach.cause === "network" ? reach.cause : "agent_stall");
    const next = suspendRig(opts.runtimeDir, agent, cause, reach.detail, opts.nowMs);
    state = readRigLifecycleState(opts.runtimeDir);
    opts.onProbe?.({ agent, recovered: false, entry: next, detail: reach.detail });
  }
  return state;
}

// ── FIX-1474: builder-child LIVENESS probe (the lost-child killer) ──────────

/** Default poll cadence (ms) for the builder-child liveness probe. Cheap (one
 *  `kill(pid, 0)` per tick). Overridable via ROLL_LIVENESS_POLL_MS for tests. */
const LIVENESS_POLL_MS = 5_000;

/** Consecutive DEAD observations required before a child is declared lost. One
 *  tick can race the OS reap/`close` handshake (a just-exited child can read
 *  as a zombie for a moment), so a single dead read is a blip, never a verdict. */
const LIVENESS_CONFIRM_TICKS = 2;

/** A live liveness-probe handle. `stop()` clears the timer and returns whether
 *  the probe declared the child lost (so the caller can fold it into the
 *  returned `agent_exited` event). */
export interface BuilderLivenessProbe {
  stop(): { lost: boolean };
}

/** Default liveness check: signal 0. ESRCH (no such process) ⇒ dead; EPERM
 *  means the process EXISTS but is owned by someone else ⇒ alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/**
 * FIX-1474 — start the bounded liveness probe around a blocking builder spawn.
 * The FIX-907 timeout watchdog covers a child that is ALIVE (hung / silent /
 * thrashing); it CANNOT see a child that DIED out-of-band while the spawn
 * await never settled (external SIGKILL of a process-tree member, PTY leader
 * death, lost exit delivery) — the exact shape that hung supervised cycles
 * forever with no terminal state.
 *
 * Each tick it reads the spawned child's pid (reported via the `onSpawn`
 * spawn seam; `undefined` until the spawn starts — nothing to accuse yet) and
 * asks the injected `isAlive`. After {@link LIVENESS_CONFIRM_TICKS} consecutive
 * dead observations it declares the child LOST:
 *   1. records the auditable `cycle:agent_lost` event FIRST (durable, so the
 *      death is observable even if the kill races),
 *   2. reaps the leftover process tree ({@link killLiveAgents} SIGKILL — a
 *      no-op when the tree is already gone),
 *   3. fires `onLost` so the caller can resolve its spawn race and converge
 *      the cycle to the explicit `aborted` terminal.
 *
 * The probe stands down the moment the spawn settles (`spawnPending()` false)
 * so a finished cycle is never accused. Best-effort throughout: a probe blip
 * (a throwing `isAlive`) reads as ALIVE — never a death verdict. Injectable
 * seams (`pid`, `spawnPending`, `isAlive`, `appendEvent`, `kill`, `onLost`,
 * `pollMs`, `confirmTicks`) keep it unit-testable with no real process/timer.
 */
export function startBuilderLivenessProbe(opts: {
  cycleId: string;
  agent: string;
  /** The spawned child's pid; `undefined` until the spawn reports it. */
  pid: () => number | undefined;
  /** True while the spawn await is unsettled; a settled spawn ⇒ inert probe. */
  spawnPending: () => boolean;
  /** Liveness check (default: `kill(pid, 0)`). A THROW is a blip ⇒ alive. */
  isAlive?: (pid: number) => boolean;
  /** Append the cycle:agent_lost event (best-effort). */
  appendEvent: (ev: RollEvent) => void;
  /** Reap the leftover agent process tree (returns count signalled). */
  kill?: () => number;
  /** Fired once when the child is declared lost (drives the spawn race). */
  onLost?: (info: { pid: number }) => void;
  /** Poll cadence ms (default {@link LIVENESS_POLL_MS}; tests pin a small value). */
  pollMs?: number;
  /** Consecutive dead observations before declaring lost (default
   *  {@link LIVENESS_CONFIRM_TICKS}). */
  confirmTicks?: number;
}): BuilderLivenessProbe {
  const { cycleId, agent, appendEvent } = opts;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const kill = opts.kill ?? ((): number => killLiveAgents("SIGKILL"));
  const pollMs = opts.pollMs ?? (Number((process.env["ROLL_LIVENESS_POLL_MS"] ?? "").trim()) || LIVENESS_POLL_MS);
  const confirmTicks = opts.confirmTicks ?? LIVENESS_CONFIRM_TICKS;
  let lost = false;
  let deadStreak = 0;

  const tick = (): void => {
    if (lost || !opts.spawnPending()) return;
    const pid = opts.pid();
    if (pid === undefined) {
      deadStreak = 0;
      return;
    }
    let alive = true;
    try {
      alive = isAlive(pid);
    } catch {
      /* a probe blip is NOT a death — skip */
    }
    if (alive) {
      deadStreak = 0;
      return;
    }
    deadStreak += 1;
    if (deadStreak < confirmTicks) return;
    lost = true;
    clearInterval(timer);
    // Record FIRST (durable), then reap + signal — the death must be
    // observable even if the kill races the cycle's own teardown.
    try {
      appendEvent({ type: "cycle:agent_lost", cycleId, agent, pid, ts: Date.now() });
    } catch {
      /* event append is best-effort */
    }
    try {
      kill();
    } catch {
      /* the tree may already be gone — the verdict stands */
    }
    try {
      opts.onLost?.({ pid });
    } catch {
      /* the caller's race resolve must never crash the probe */
    }
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      return { lost };
    },
  };
}
